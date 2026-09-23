import type { NoteEvent, DeviationSegment } from './db'
import { mergeSplitNotes, splitWindowForScoreReference, UNISON_WINDOW_MS } from './noteCleanup'

// DesignDoc Section 5「アライメント」: Basic Pitch pathの音符列同士のシーケンスアライメント。
// M1予備検証(Appendix B)で「音符を出現順で単純対応付けする方法は脆い」ことが確認されたため、
// 弾き忘れ/余分な音符を扱えるNeedleman-Wunsch風の編集距離ベースの全体アライメントを実装する。

export type NoteAlignmentPair = { ref?: NoteEvent; take?: NoteEvent }

const INSERT_DELETE_COST = 6 // 弾き忘れ/余分な音符1つ分のペナルティ(暫定値。M1で調整)
const TIMING_COST_PER_100MS = 1

function pairCost(a: NoteEvent, b: NoteEvent, timingCostPer100Ms: number = TIMING_COST_PER_100MS): number {
  const pitchDiff = Math.abs(a.pitch - b.pitch)
  const timingDiff = (Math.abs(a.startMs - b.startMs) / 100) * timingCostPer100Ms
  return pitchDiff + timingDiff
}

/** timingCostPer100Ms を下げると時刻差より音高を重視した対応になる(ルバート追従の種に使う) */
export function alignNoteSequences(
  ref: NoteEvent[],
  take: NoteEvent[],
  timingCostPer100Ms: number = TIMING_COST_PER_100MS,
): NoteAlignmentPair[] {
  const cost = (a: NoteEvent, b: NoteEvent) => pairCost(a, b, timingCostPer100Ms)
  const n = ref.length
  const m = take.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i * INSERT_DELETE_COST
  for (let j = 0; j <= m; j++) dp[0][j] = j * INSERT_DELETE_COST

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = dp[i - 1][j - 1] + cost(ref[i - 1], take[j - 1])
      const del = dp[i - 1][j] + INSERT_DELETE_COST // refにあってtakeにない = 弾き忘れ
      const ins = dp[i][j - 1] + INSERT_DELETE_COST // takeにあってrefにない = 余分に弾いた
      dp[i][j] = Math.min(sub, del, ins)
    }
  }

  const pairs: NoteAlignmentPair[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + cost(ref[i - 1], take[j - 1])) {
      pairs.unshift({ ref: ref[i - 1], take: take[j - 1] })
      i--
      j--
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + INSERT_DELETE_COST) {
      pairs.unshift({ ref: ref[i - 1], take: undefined })
      i--
    } else {
      pairs.unshift({ ref: undefined, take: take[j - 1] })
      j--
    }
  }
  return pairs
}

/**
 * 対応が付いた音の開始時刻に take = a + b * ref の直線を当てる。
 * b-1 がテンポ差、a が全体オフセット。どちらも「不安定さ」ではないので、
 * ばらつきを測る前に取り除く。
 */
export type TimeFit = { offsetMs: number; ratio: number }

/**
 * 対応する2つの時刻列に y = a + b * x の直線を最小二乗で当てる。
 * b-1 がテンポ差、a が全体オフセット。音符列でもコード列でも使うので独立させている。
 */
export function fitLine(xs: number[], ys: number[]): TimeFit {
  const n = xs.length
  if (n < 3) return { offsetMs: 0, ratio: 1 }
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  // 2音以下や全音同時刻では傾きが決まらないので比1に固定してオフセットだけ取る
  const ratio = sxx > 0 ? sxy / sxx : 1
  return { offsetMs: my - ratio * mx, ratio }
}

function fitTimeMap(pairs: NoteAlignmentPair[]): TimeFit {
  const xs: number[] = []
  const ys: number[] = []
  for (const p of pairs) {
    if (p.ref && p.take) {
      xs.push(p.ref.startMs)
      ys.push(p.take.startMs)
    }
  }
  return fitLine(xs, ys)
}

export type DiagnosisAlignment = {
  /** 分割統合後の基準側の音符 */
  ref: NoteEvent[]
  /** 分割統合後・時間補正前の今回側の音符(表示にはこちらを使う) */
  take: NoteEvent[]
  /** 補正後の時間軸で取り直した対応。take側の音符は元の時刻のまま返す */
  pairs: NoteAlignmentPair[]
  /** take = offsetMs + ratio * ref。事前正規化の倍率も畳み込んだ「元の時刻どうし」の直線 */
  fit: TimeFit
  /** 採用した事前正規化の倍率(take の時間軸を 1/tempoScale に縮めてからアライメントした)。1 = 正規化なし */
  tempoScale: number
  mergedNoteCount: number
}

/**
 * テンポ事前正規化の候補。take の時刻 t を (t - anchorTakeMs) / scale + anchorRefMs に写してからアライメントする。
 * scale = 1, anchor 0 は「何もしない」= 従来どおりの経路で、候補に必ず含める。
 */
type Prescale = { scale: number; anchorRefMs: number; anchorTakeMs: number }

/** 事前正規化を試みる最小の音数と、テンポ比を測るのに必要な最小の長さ(短いと 1 音の揺れで比が飛ぶ) */
const PRESCALE_MIN_NOTES = 4
const PRESCALE_MIN_SPAN_MS = 1000
/** 人間の練習で起きうるテンポ比の範囲(0.4 = 2.5 倍速い、2.5 = 2.5 倍遅い)。外れたら比の推定が壊れているとみなす */
const PRESCALE_SCALE_MIN = 0.4
const PRESCALE_SCALE_MAX = 2.5

/**
 * テンポ比の候補: テイク全体の長さ(最初の音〜最後の音)の比。
 * 両端の音が余分/弾き忘れだと比がずれるので、端から k 音目どうし(k = 0, 1, 2)で測った 3 通りを出す。
 * 最終的な傾きは候補の上で直線フィットが取り直すので、候補は「1 パス目のアライメントが崩れない程度」に近ければよい。
 */
function prescaleCandidates(ref: NoteEvent[], take: NoteEvent[]): Prescale[] {
  const out: Prescale[] = [{ scale: 1, anchorRefMs: 0, anchorTakeMs: 0 }]
  const n = ref.length
  const m = take.length
  if (n < PRESCALE_MIN_NOTES || m < PRESCALE_MIN_NOTES) return out
  for (let k = 0; k <= 2; k++) {
    if (n - 1 - k <= k || m - 1 - k <= k) break
    const spanRef = ref[n - 1 - k].startMs - ref[k].startMs
    const spanTake = take[m - 1 - k].startMs - take[k].startMs
    if (spanRef < PRESCALE_MIN_SPAN_MS || spanTake < PRESCALE_MIN_SPAN_MS) continue
    const scale = spanTake / spanRef
    if (scale < PRESCALE_SCALE_MIN || scale > PRESCALE_SCALE_MAX) continue
    out.push({ scale, anchorRefMs: ref[k].startMs, anchorTakeMs: take[k].startMs })
  }
  return out
}

type IndexedNote = NoteEvent & { index: number }

type AlignmentTrial = {
  pairs: NoteAlignmentPair[]
  fit: TimeFit
  matched: number
  /** 2 パス目のアライメントの総コスト(対応: 音高差 + 残差/100、非対応: 挿入削除コスト)。候補の選択基準 */
  cost: number
}

/**
 * 1 つの事前正規化候補について、従来の 2 パス(仮アライメント → 直線フィット → 補正した時間軸で再アライメント)を回す。
 * 返す fit と pairs は元の時刻の take に戻してある。
 */
function alignWithPrescale(ref: NoteEvent[], take: NoteEvent[], p: Prescale): AlignmentTrial {
  const normalized = take.map((t) => ({ ...t, startMs: (t.startMs - p.anchorTakeMs) / p.scale + p.anchorRefMs }))
  const fitN = fitTimeMap(alignNoteSequences(ref, normalized))
  // normalized = a + b * ref、normalized = (t - anchorTake) / scale + anchorRef を合成して t = A + B * ref に戻す
  const fit: TimeFit = { offsetMs: p.anchorTakeMs + p.scale * (fitN.offsetMs - p.anchorRefMs), ratio: p.scale * fitN.ratio }
  return { ...alignOnMappedAxis(ref, take, (t) => (t - fit.offsetMs) / fit.ratio), fit }
}

/**
 * take の時刻を toRef で基準の時間軸に写してからアライメントし、元の時刻の take で対応を返す。
 * cost は写した時間軸での総コスト(候補どうしの比較に使う)。
 */
function alignOnMappedAxis(
  ref: NoteEvent[],
  take: NoteEvent[],
  toRef: (takeMs: number) => number,
  timingCostPer100Ms: number = TIMING_COST_PER_100MS,
): { pairs: NoteAlignmentPair[]; matched: number; cost: number } {
  const mapped: IndexedNote[] = take.map((t, i) => ({ ...t, startMs: toRef(t.startMs), index: i }))
  const rawPairs = alignNoteSequences(ref, mapped, timingCostPer100Ms)
  const pairs: NoteAlignmentPair[] = rawPairs.map((q) => ({
    ref: q.ref,
    take: q.take ? take[(q.take as IndexedNote).index] : undefined,
  }))
  let matched = 0
  let cost = 0
  for (const q of rawPairs) {
    if (q.ref && q.take) {
      matched++
      cost += pairCost(q.ref, q.take)
    } else cost += INSERT_DELETE_COST
  }
  return { pairs, matched, cost }
}

// ---- 楽譜由来のお手本とのルバート追従(DiagnosisOptions.referenceIsScore) ----
// 格子どおりのお手本と人の演奏では、テンポ差を 1 本の直線で除いても局所的なテンポの揺れ(ルバート・フレーズ末の減速)が残り、
// 8 小節を超えるとずれが挿入削除コストを超えて対応が崩れる(GAPS test、正解 MIDI vs 楽譜 16 小節で正しい対応 67%。
// docs/score-import/real-performance-eval.md)。直線補正の後に、基準の時間軸で一定間隔の節点を持つ連続区分線形の時間写像を当て直す。

/** 区分線形の節点の間隔(基準の時間軸、ms)。GAPS で 1.5〜6 秒を試して 3 秒が最良(差は小さい) */
const TEMPO_TRACK_KNOT_MS = 3000
/** 各節点を直線補正の値に引き寄せる強さ(擬似観測の個数)。対応の少ない区間で写像が暴れないように */
const TEMPO_TRACK_PRIOR_WEIGHT = 2
/** 区分線形の種にするアライメントの時刻コスト(100ms あたり)。低くして音高で対応を取る(ずれた時間軸に引きずられない) */
const TEMPO_TRACK_SEED_TIMING_COST = 0.1
/** 節点間の傾きの下限(直線補正の傾きに対する比)。時間が逆行する写像を作らない */
const TEMPO_TRACK_MIN_SLOPE = 0.3

/** 連続区分線形の写像 take = f(ref)。xs は基準の時間軸の節点、ys はそこでの take の時刻(単調増加) */
type PiecewiseMap = { xs: number[]; ys: number[] }

function interpolate(xs: number[], ys: number[], x: number): number {
  const n = xs.length
  if (x <= xs[0]) return ys[0] + ((x - xs[0]) * (ys[1] - ys[0])) / (xs[1] - xs[0])
  if (x >= xs[n - 1]) return ys[n - 1] + ((x - xs[n - 1]) * (ys[n - 1] - ys[n - 2])) / (xs[n - 1] - xs[n - 2])
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  return ys[lo] + ((x - xs[lo]) * (ys[hi] - ys[lo])) / (xs[hi] - xs[lo])
}

/** 対応点 (xs, ys) に連続区分線形を最小二乗で当てる。節点は [x0, x1] を knotMs 前後の等間隔、各節点に直線 prior への引き寄せ */
function fitPiecewise(xs: number[], ys: number[], prior: TimeFit, x0: number, x1: number): PiecewiseMap {
  const k = Math.max(1, Math.round((x1 - x0) / TEMPO_TRACK_KNOT_MS))
  const step = (x1 - x0) / k
  const knots = Array.from({ length: k + 1 }, (_, i) => x0 + i * step)
  const n = k + 1
  // 正規方程式(三重対角)。基底は節点ごとの山形関数
  const lower = new Array<number>(n).fill(0)
  const diag = new Array<number>(n).fill(0)
  const upper = new Array<number>(n).fill(0)
  const rhs = new Array<number>(n).fill(0)
  for (let i = 0; i < xs.length; i++) {
    const seg = Math.max(0, Math.min(k - 1, Math.floor((xs[i] - x0) / step)))
    const t = Math.max(0, Math.min(1, (xs[i] - knots[seg]) / step))
    const w0 = 1 - t
    const w1 = t
    diag[seg] += w0 * w0
    diag[seg + 1] += w1 * w1
    upper[seg] += w0 * w1
    lower[seg + 1] += w0 * w1
    rhs[seg] += w0 * ys[i]
    rhs[seg + 1] += w1 * ys[i]
  }
  for (let i = 0; i < n; i++) {
    diag[i] += TEMPO_TRACK_PRIOR_WEIGHT
    rhs[i] += TEMPO_TRACK_PRIOR_WEIGHT * (prior.offsetMs + prior.ratio * knots[i])
  }
  // Thomas 法(対角優位なので枢軸選択は要らない)
  for (let i = 1; i < n; i++) {
    const m = lower[i] / diag[i - 1]
    diag[i] -= m * upper[i - 1]
    rhs[i] -= m * rhs[i - 1]
  }
  const y = new Array<number>(n).fill(0)
  y[n - 1] = rhs[n - 1] / diag[n - 1]
  for (let i = n - 2; i >= 0; i--) y[i] = (rhs[i] - upper[i] * y[i + 1]) / diag[i]
  const minRise = TEMPO_TRACK_MIN_SLOPE * prior.ratio * step
  for (let i = 1; i < n; i++) if (y[i] - y[i - 1] < minRise) y[i] = y[i - 1] + minRise
  return { xs: knots, ys: y }
}

/**
 * 直線補正で得た対応を出発点に、区分線形の時間写像で取り直す。総コストが下がった時だけ採る(下がらなければ null)。
 * 種の対応は時刻コストを下げたアライメントで取り、音高の合った対応だけを使う
 * (直線補正の対応をそのまま使うと、崩れた区間の誤対応に写像が引きずられて回復しない)。
 */
function trackLocalTempo(ref: NoteEvent[], take: NoteEvent[], base: AlignmentTrial): AlignmentTrial | null {
  if (ref.length < PRESCALE_MIN_NOTES) return null
  const x0 = ref[0].startMs
  const x1 = ref[ref.length - 1].startMs
  if (x1 <= x0) return null
  const { fit } = base
  const seed = alignOnMappedAxis(ref, take, (t) => (t - fit.offsetMs) / fit.ratio, TEMPO_TRACK_SEED_TIMING_COST)
  const xs: number[] = []
  const ys: number[] = []
  for (const p of seed.pairs) {
    if (p.ref && p.take && p.ref.pitch === p.take.pitch) {
      xs.push(p.ref.startMs)
      ys.push(p.take.startMs)
    }
  }
  if (xs.length < PRESCALE_MIN_NOTES) return null
  const map = fitPiecewise(xs, ys, fit, x0, x1)
  const trial = alignOnMappedAxis(ref, take, (t) => interpolate(map.ys, map.xs, t))
  if (trial.cost >= base.cost - 1e-9) return null
  // ばらつき・テンポ差・オフセットの定義は変えない: 取り直した対応に直線を当て直す
  const mx: number[] = []
  const my: number[] = []
  for (const p of trial.pairs) {
    if (p.ref && p.take) {
      mx.push(p.ref.startMs)
      my.push(p.take.startMs)
    }
  }
  return { ...trial, fit: fitLine(mx, my) }
}

export type DiagnosisOptions = {
  /**
   * 基準が楽譜ファイル由来のお手本(Take.sourceType 'importedScore')。格子どおりで音の分割が無く、
   * 相手は人の演奏(テンポが揺れる)という前提の比較に切り替える:
   *  - 基準側は分割統合をせず、同時刻の同音(多声部のユニゾン)だけまとめる。テイク側は、基準で速い同音連打がある音高だけ
   *    分割統合の窓を縮める(splitWindowForScoreReference)
   *  - 直線のテンポ補正の後に区分線形のテンポ追従(trackLocalTempo)を試し、総コストが下がれば対応をそちらで取り直す
   * 人間どうしの比較(prev・録音のお手本)には使わない(分割はどちらのテイクにもあり、テンポ追従は GAPS の prev 相当で
   * 対応が変わらず、ばらつきだけが ±30ms 動く組があったため)。
   */
  referenceIsScore?: boolean
}

/**
 * 診断用のアライメント。分割統合 → (テンポ事前正規化の候補ごとに)仮アライメント → オフセット/テンポ差の推定 →
 * 補正した時間軸で再アライメント、の2パス。
 * 1パスだと、テンポが数%違うだけでフレーズ後半の時刻差が数百msに達し、
 * 「対応付け」より「弾き忘れ+余分」と解釈するほうが安くなって対応が崩れる。
 *
 * 2 パスでも、テンポ差 × フレーズ長のドリフトが挿入削除コスト(600ms 相当)を超えると 1 パス目が崩れ、
 * 直線フィットも崩れて回復しない(格子どおりのお手本 23 秒でテンポ差 5% → 対応 46/55、ジッタ 313ms、
 * 推定テンポ差 0.4%。docs/score-import/tempo-normalization.md)。そこで、テイク全体の長さの比で
 * take の時間軸を先に縮めた候補も同じ 2 パスに通し、2 パス目のアライメント総コストが最小(同じなら
 * 正規化なし)のものを採る。テンポ差が小さければ候補どうしの 1 パス目の対応は同じになり、
 * 直線フィットは線形変換に対して不変なので結果は正規化なしと一致する。
 */
export function alignForDiagnosis(refRaw: NoteEvent[], takeRaw: NoteEvent[], opts: DiagnosisOptions = {}): DiagnosisAlignment {
  const score = opts.referenceIsScore === true
  const refMerged = mergeSplitNotes(refRaw, score ? UNISON_WINDOW_MS : undefined)
  const takeMerged = mergeSplitNotes(takeRaw, score ? splitWindowForScoreReference(refMerged.notes, takeRaw) : undefined)
  const ref = refMerged.notes
  const take = takeMerged.notes

  let best: AlignmentTrial | null = null
  let bestScale = 1
  for (const p of prescaleCandidates(ref, take)) {
    const trial = alignWithPrescale(ref, take, p)
    // 総コストで選ぶ(対応数の最大化だと、残差の大きい対応を 1 つ増やすだけの候補が勝ってしまう)。
    // 非対応は 1 音 6、対応は音高差 + 残差 100ms あたり 1 なので、対応を増やしつつ残差を小さくする候補が残る
    if (!best || trial.cost < best.cost - 1e-9) {
      best = trial
      bestScale = p.scale
    }
  }
  if (score) best = trackLocalTempo(ref, take, best!) ?? best
  const { pairs, fit } = best!
  return { ref, take, pairs, fit, tempoScale: bestScale, mergedNoteCount: refMerged.mergedCount + takeMerged.mergedCount }
}

export type DiagnosisMetrics = {
  /** 対応が付いた音の中で音高が合っていた割合(0〜1) */
  noteMatchRate: number
  /** 対応が付かなかった音の数(弾き忘れ+余分) */
  missedOrExtraNoteCount: number
  /** 対応が付いた音の数。ばらつき推定の信頼度の根拠になるので隠さない */
  alignedNoteCount: number
  /** 分割統合で畳んだ音の数(両テイク合計)。これも隠さない */
  mergedNoteCount: number
  /** オフセットとテンポ差を除いた残差の標準偏差(ms)。テイク間の相対的なばらつき */
  timingJitterMs: number
  /**
   * 基準に対するテンポ差(%)。正なら今回のほうが速い。
   * 直線 take = a + b * ref の傾き b は「今回の所要時間 / 基準の所要時間」なので、テンポ比は 1/b。
   * (以前は b - 1 を返していて符号が逆だった。テンポ差が数%を超えると推定自体が崩れていたので表面化していなかった)
   */
  tempoDiffPct: number
  /** 採用したテンポ事前正規化の倍率(1 = 正規化なし)。tempoDiffPct にはこれも含まれている */
  tempoScale: number
  /** 基準に対する全体の時間オフセット(ms)。録音開始の間の取り方の差で、演奏の質ではない */
  onsetOffsetMs: number
  deviationTimeline: DeviationSegment[]
}

/** 補正後の残差がこれを超えた音を、タイムラインで「タイミングずれ」として印を付ける */
const TIMING_FLAG_MS = 80

/**
 * DesignDoc Section 5 手順6-7: 診断メトリクス算出 + 差分の可視化用データ。
 *
 * 以前はこれらを1つの「安定度スコア(0〜100)」に合成していたが、廃止した。
 * 理由は3つ。
 *  1. 合成に使っていた timingDriftMs(開始時刻差の平均絶対値)は「ばらつき」ではなく
 *     「ズレ」で、一律の時間シフトやテンポ差という不安定さと無関係な量で最大減点になっていた
 *     (検証: 完璧に均一な演奏を+150msシフト → 70点、テンポ+5% → 70点)。
 *  2. 分割由来の過剰検出をスコア式で吸収していたため、演奏が同じでも14〜16点動いていた。
 *     DesignDocが「区別できている」とした自己比較72 vs お手本比較67の5点差はこの中に埋まる。
 *  3. 無単位の合成値は「なぜその値か」を説明できない。
 * 代わりに、単位を持つ量に分解してそのまま返す。ばらつきは ms、一致率は %。
 */
export function diagnose(refRaw: NoteEvent[], takeRaw: NoteEvent[], opts: DiagnosisOptions = {}): DiagnosisMetrics {
  const { pairs, fit, tempoScale, mergedNoteCount } = alignForDiagnosis(refRaw, takeRaw, opts)
  const matched = pairs.filter((p) => p.ref && p.take)
  const missedOrExtraNoteCount = pairs.length - matched.length

  const pitchMatches = matched.filter((p) => p.ref!.pitch === p.take!.pitch).length
  const noteMatchRate = matched.length ? pitchMatches / matched.length : 0

  // 補正後の残差: take側の時刻を fit で基準の時間軸に戻してから差を取る
  const residual = (p: NoteAlignmentPair) => (p.take!.startMs - fit.offsetMs) / fit.ratio - p.ref!.startMs
  const residuals = matched.map(residual)
  const n = residuals.length
  const timingJitterMs =
    n >= 3 ? Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / (n - 2)) : 0

  const deviationTimeline: DeviationSegment[] = pairs
    .filter((p) => p.ref)
    .map((p) => {
      let severity = 0
      if (!p.take) severity = 2 // 弾き忘れ
      else if (p.ref!.pitch !== p.take.pitch) severity = 2 // 音程違い
      else if (Math.abs(residual(p)) > TIMING_FLAG_MS) severity = 1 // タイミングずれ
      return { startMs: p.ref!.startMs, endMs: p.ref!.startMs + p.ref!.durationMs, severity }
    })

  return {
    noteMatchRate: Number(noteMatchRate.toFixed(3)),
    missedOrExtraNoteCount,
    alignedNoteCount: matched.length,
    mergedNoteCount,
    timingJitterMs: Math.round(timingJitterMs * 10) / 10,
    tempoDiffPct: Math.round((1 / fit.ratio - 1) * 100 * 100) / 100,
    tempoScale: Math.round(tempoScale * 1000) / 1000,
    onsetOffsetMs: Math.round(fit.offsetMs),
    deviationTimeline,
  }
}
