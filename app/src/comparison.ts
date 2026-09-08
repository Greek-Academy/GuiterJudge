import type { NoteEvent, DeviationSegment } from './db'
import { mergeSplitNotes } from './noteCleanup'

// DesignDoc Section 5「アライメント」: Basic Pitch pathの音符列同士のシーケンスアライメント。
// M1予備検証(Appendix B)で「音符を出現順で単純対応付けする方法は脆い」ことが確認されたため、
// 弾き忘れ/余分な音符を扱えるNeedleman-Wunsch風の編集距離ベースの全体アライメントを実装する。

export type NoteAlignmentPair = { ref?: NoteEvent; take?: NoteEvent }

const INSERT_DELETE_COST = 6 // 弾き忘れ/余分な音符1つ分のペナルティ(暫定値。M1で調整)
const TIMING_COST_PER_100MS = 1

function pairCost(a: NoteEvent, b: NoteEvent): number {
  const pitchDiff = Math.abs(a.pitch - b.pitch)
  const timingDiff = (Math.abs(a.startMs - b.startMs) / 100) * TIMING_COST_PER_100MS
  return pitchDiff + timingDiff
}

export function alignNoteSequences(ref: NoteEvent[], take: NoteEvent[]): NoteAlignmentPair[] {
  const n = ref.length
  const m = take.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i * INSERT_DELETE_COST
  for (let j = 0; j <= m; j++) dp[0][j] = j * INSERT_DELETE_COST

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = dp[i - 1][j - 1] + pairCost(ref[i - 1], take[j - 1])
      const del = dp[i - 1][j] + INSERT_DELETE_COST // refにあってtakeにない = 弾き忘れ
      const ins = dp[i][j - 1] + INSERT_DELETE_COST // takeにあってrefにない = 余分に弾いた
      dp[i][j] = Math.min(sub, del, ins)
    }
  }

  const pairs: NoteAlignmentPair[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + pairCost(ref[i - 1], take[j - 1])) {
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
type TimeFit = { offsetMs: number; ratio: number }

function fitTimeMap(pairs: NoteAlignmentPair[]): TimeFit {
  const xs: number[] = []
  const ys: number[] = []
  for (const p of pairs) {
    if (p.ref && p.take) {
      xs.push(p.ref.startMs)
      ys.push(p.take.startMs)
    }
  }
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

export type DiagnosisAlignment = {
  /** 分割統合後の基準側の音符 */
  ref: NoteEvent[]
  /** 分割統合後・時間補正前の今回側の音符(表示にはこちらを使う) */
  take: NoteEvent[]
  /** 補正後の時間軸で取り直した対応。take側の音符は元の時刻のまま返す */
  pairs: NoteAlignmentPair[]
  fit: TimeFit
  mergedNoteCount: number
}

/**
 * 診断用のアライメント。分割統合 → 仮アライメント → オフセット/テンポ差の推定 →
 * 補正した時間軸で再アライメント、の2パス。
 * 1パスだと、テンポが数%違うだけでフレーズ後半の時刻差が数百msに達し、
 * 「対応付け」より「弾き忘れ+余分」と解釈するほうが安くなって対応が崩れる。
 */
export function alignForDiagnosis(refRaw: NoteEvent[], takeRaw: NoteEvent[]): DiagnosisAlignment {
  const refMerged = mergeSplitNotes(refRaw)
  const takeMerged = mergeSplitNotes(takeRaw)
  const ref = refMerged.notes
  const take = takeMerged.notes

  const fit = fitTimeMap(alignNoteSequences(ref, take))
  const corrected = take.map((n) => ({ ...n, startMs: (n.startMs - fit.offsetMs) / fit.ratio }))
  const pairs = alignNoteSequences(ref, corrected).map((p) => ({
    ref: p.ref,
    take: p.take ? take[corrected.indexOf(p.take)] : undefined,
  }))
  return { ref, take, pairs, fit, mergedNoteCount: refMerged.mergedCount + takeMerged.mergedCount }
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
  /** 基準に対するテンポ差(%)。正なら今回のほうが速い */
  tempoDiffPct: number
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
export function diagnose(refRaw: NoteEvent[], takeRaw: NoteEvent[]): DiagnosisMetrics {
  const { pairs, fit, mergedNoteCount } = alignForDiagnosis(refRaw, takeRaw)
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
    tempoDiffPct: Math.round((fit.ratio - 1) * 100 * 100) / 100,
    onsetOffsetMs: Math.round(fit.offsetMs),
    deviationTimeline,
  }
}
