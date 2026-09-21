import { computeChromagram, type Chromagram } from './chroma'
import { fitLine } from './comparison'

// 和音認識: クロマグラム(chroma.ts) → コードのテンプレートと照合 → 時間方向に平滑化 → コード区間列。
//
// 「音符起こし(Basic Pitch)がストロークを分解できない」問題への回答として、
// 個々の音符ではなく「どのコードが鳴っていたか」を取る。学習は要らず、全部ブラウザ内で閉じる。
// 分かるのは「そのコードが鳴ったか」「切り替えがいつだったか」まで。
// 押さえ間違いで6弦のうち1本だけ違う、といった音符単位のことはこの方式では分からない。
//
// 単音フレーズに対してもコードは出てしまう(E の単音は倍音構成からEメジャーに見える)。
// だから和音認識の結果は、スレッド側で「和音の練習」と指定されたときだけ画面に出す(Thread.chordMode)。

export type ChordQuality = 'maj' | 'min' | '7' | 'min7'

export type ChordEvent = {
  /** 0=C … 11=B。無音区間(N)は null */
  root: number | null
  quality: ChordQuality | null
  /** 表示用。"C" "Am" "G7" "Dm7"、無音は "N" */
  label: string
  startMs: number
  endMs: number
  /** 区間内での、選ばれたコードのテンプレートとの平均コサイン類似度(0〜1) */
  confidence: number
}

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** コードの種類ごとの構成音(ルートからの半音数)と表記 */
const QUALITIES: { quality: ChordQuality; intervals: number[]; suffix: string }[] = [
  { quality: 'maj', intervals: [0, 4, 7], suffix: '' },
  { quality: 'min', intervals: [0, 3, 7], suffix: 'm' },
  { quality: '7', intervals: [0, 4, 7, 10], suffix: '7' },
  { quality: 'min7', intervals: [0, 3, 7, 10], suffix: 'm7' },
]

/**
 * 倍音を考慮したテンプレート。弦の音は基音だけでなく 2,3,4,5,6倍音を含み、
 * それぞれ 0, 0, +7(完全5度), 0, +4(長3度), +7 半音のクラスに落ちる。
 * 観測されるクロマにはこれが乗っているので、テンプレート側にも同じ形で乗せておくと
 * 「構成音だけ1、他は0」の二値テンプレートより照合が安定する。
 */
const HARMONIC_INTERVALS = [0, 0, 7, 0, 4, 7]
const HARMONIC_DECAY = 0.6

export const NO_CHORD_LABEL = 'N'

type Template = { root: number; quality: ChordQuality; label: string; vector: Float32Array }

function buildTemplates(): Template[] {
  const out: Template[] = []
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const v = new Float32Array(12)
      for (const iv of q.intervals) {
        HARMONIC_INTERVALS.forEach((h, i) => {
          v[(root + iv + h) % 12] += Math.pow(HARMONIC_DECAY, i)
        })
      }
      let norm = 0
      for (let c = 0; c < 12; c++) norm += v[c] * v[c]
      norm = Math.sqrt(norm)
      for (let c = 0; c < 12; c++) v[c] /= norm
      out.push({ root, quality: q.quality, label: PITCH_CLASS_NAMES[root] + q.suffix, vector: v })
    }
  }
  return out
}

const TEMPLATES = buildTemplates()

export function chordLabel(root: number, quality: ChordQuality): string {
  const q = QUALITIES.find((x) => x.quality === quality)!
  return PITCH_CLASS_NAMES[root] + q.suffix
}

/**
 * 無音判定: フレームRMSが録音全体の最大RMSに対してこの比を下回れば「何も鳴っていない(N)」。
 * preprocess で音量正規化される前の値でも、比で見るので影響しない。
 */
const SILENCE_RATIO = 0.08
/**
 * 鳴っているフレームでの N の観測スコア。コードの類似度がこれを下回ると「コードとして読めない」扱い。
 * 単音・ノイズ・減衰の尻尾がここに落ちる。
 */
const NO_CHORD_SCORE = 0.55
/**
 * コードを切り替えるときのペナルティ(類似度と同じ単位)。
 * 1フレーム(約93ms)ごとの類似度の差は 0.1〜0.3 程度なので、
 * この値なら「3〜4フレーム以上続かないコードは出ない」程度の平滑化になる。
 * 合成音で決めた 0.6 は実録音(GuitarSet)では緩すぎ、正解の 1.2〜1.35 倍の区間数に細切れになった。
 * 1.0 で区間数が正解と同数になり、精度は落ちない(0.6 → 1.0 で majmin 69.3 → 72.0%、学習側)。
 */
const SWITCH_PENALTY = 1.0
/**
 * 4音のコード(7th系)は構成音が多いぶん、あいまいなフレームでも3音のコードより高い類似度を出しやすい。
 * 弦の7倍音(短7度の少し下)も乗るので、放っておくと A が A7 に寄る。その分だけ差し引く。
 * 合成音では 0.03、実録音(GuitarSet)では 0.06 のほうが進行レベルの一致率が 4 ポイント高かった
 */
export const DEFAULT_SEVENTH_PENALTY = 0.06

/** フレームごとに、全テンプレート+N のスコアを返す。index 0..47 がテンプレート、48 が N */
function frameScores(chroma: Chromagram, seventhPenalty: number, noChordScore: number): Float32Array[] {
  const maxRms = chroma.rms.reduce((a, b) => Math.max(a, b), 0)
  return chroma.frames.map((frame, fi) => {
    const scores = new Float32Array(TEMPLATES.length + 1)
    const silent = maxRms === 0 || chroma.rms[fi] < maxRms * SILENCE_RATIO
    if (silent) {
      scores[TEMPLATES.length] = 1
      return scores
    }
    TEMPLATES.forEach((t, ti) => {
      let dot = 0
      for (let c = 0; c < 12; c++) dot += frame[c] * t.vector[c]
      scores[ti] = t.quality === '7' || t.quality === 'min7' ? dot - seventhPenalty : dot
    })
    scores[TEMPLATES.length] = noChordScore
    return scores
  })
}

/** Viterbi: 各フレームのスコアの和から切り替え回数×ペナルティを引いた値が最大になる状態列 */
function decode(scores: Float32Array[], switchPenalty: number): number[] {
  const S = TEMPLATES.length + 1
  const T = scores.length
  if (T === 0) return []
  let prev = Float64Array.from(scores[0])
  const back: Int16Array[] = []
  for (let t = 1; t < T; t++) {
    let bestPrev = 0
    for (let s = 1; s < S; s++) if (prev[s] > prev[bestPrev]) bestPrev = s
    const cur = new Float64Array(S)
    const bp = new Int16Array(S)
    for (let s = 0; s < S; s++) {
      const stay = prev[s]
      const sw = prev[bestPrev] - switchPenalty
      if (stay >= sw) {
        cur[s] = stay + scores[t][s]
        bp[s] = s
      } else {
        cur[s] = sw + scores[t][s]
        bp[s] = bestPrev
      }
    }
    back.push(bp)
    prev = cur
  }
  let s = 0
  for (let i = 1; i < S; i++) if (prev[i] > prev[s]) s = i
  const path = new Array<number>(T)
  for (let t = T - 1; t >= 0; t--) {
    path[t] = s
    if (t > 0) s = back[t - 1][s]
  }
  return path
}

/** 状態列を区間にまとめる */
function toEvents(path: number[], scores: Float32Array[], chroma: Chromagram): ChordEvent[] {
  const events: ChordEvent[] = []
  const frameLagMs = (chroma.frameMs - chroma.hopMs) / 2
  let start = 0
  for (let t = 1; t <= path.length; t++) {
    if (t < path.length && path[t] === path[start]) continue
    const s = path[start]
    let sum = 0
    for (let i = start; i < t; i++) sum += scores[i][s]
    const tmpl = s < TEMPLATES.length ? TEMPLATES[s] : null
    events.push({
      root: tmpl ? tmpl.root : null,
      quality: tmpl ? tmpl.quality : null,
      label: tmpl ? tmpl.label : NO_CHORD_LABEL,
      // フレームの代表時刻。窓の先頭にすると切り替えが系統的に早く(合成ストロークで100〜200ms)、
      // 窓の中心にすると遅く見える。「窓の過半が新しいコードになった最初のフレーム」が
      // 切り替え直後になるよう、先頭から (窓長 - ホップ)/2 だけ進めた点を使う
      startMs: Math.round(start * chroma.hopMs + frameLagMs),
      endMs: Math.round(t * chroma.hopMs + frameLagMs),
      confidence: Math.round((sum / (t - start)) * 1000) / 1000,
    })
    start = t
  }
  if (events.length) events[0].startMs = 0
  return events
}

/** 検証画面(TranscriptionLab)や評価スクリプトで振るためのパラメータ。本番は既定値 */
export type ChordRecognitionOptions = {
  logCompression?: number
  seventhPenalty?: number
  switchPenalty?: number
  noChordScore?: number
}

/** クロマグラムからコード区間列を得る。同じ音声で平滑化のパラメータだけ振るときは FFT を繰り返さずに済む */
export function recognizeChordsFromChromagram(chroma: Chromagram, opts?: ChordRecognitionOptions): ChordEvent[] {
  const scores = frameScores(chroma, opts?.seventhPenalty ?? DEFAULT_SEVENTH_PENALTY, opts?.noChordScore ?? NO_CHORD_SCORE)
  return toEvents(decode(scores, opts?.switchPenalty ?? SWITCH_PENALTY), scores, chroma)
}

/** サンプル列からコード区間列を得る。時間軸は入力の先頭が 0 */
export function recognizeChords(samples: Float32Array, sampleRate: number, opts?: ChordRecognitionOptions): ChordEvent[] {
  return recognizeChordsFromChromagram(computeChromagram(samples, sampleRate, { logCompression: opts?.logCompression }), opts)
}

/** 前処理済み(22050Hzモノラル)のAudioBufferから。transcribe() と同じバッファを渡すこと */
export function recognizeChordsFromBuffer(buffer: AudioBuffer, opts?: ChordRecognitionOptions): ChordEvent[] {
  return recognizeChords(buffer.getChannelData(0), buffer.sampleRate, opts)
}

// --- コード列の比較 ------------------------------------------------------------

/** N を落とし、同じコードが続く区間を1つに畳んだ「コード進行」 */
export function chordProgression(events: ChordEvent[]): ChordEvent[] {
  const out: ChordEvent[] = []
  for (const e of events) {
    if (e.root === null) continue
    const last = out[out.length - 1]
    if (last && last.label === e.label) {
      last.endMs = e.endMs
      last.confidence = Math.round(((last.confidence + e.confidence) / 2) * 1000) / 1000
    } else {
      out.push({ ...e })
    }
  }
  return out
}

export type ChordAlignmentPair = { ref?: ChordEvent; take?: ChordEvent }

const CHORD_GAP_COST = 1
/** 同じルートで種類だけ違う(C と C7 等)は完全な別コードより近いとみなす */
const SAME_ROOT_COST = 0.4
const DIFFERENT_CHORD_COST = 1.2

function chordPairCost(a: ChordEvent, b: ChordEvent): number {
  if (a.label === b.label) return 0
  if (a.root === b.root) return SAME_ROOT_COST
  return DIFFERENT_CHORD_COST
}

/** コード進行どうしの Needleman-Wunsch 風アライメント(comparison.ts の音符版と同じ考え方) */
export function alignChordSequences(ref: ChordEvent[], take: ChordEvent[]): ChordAlignmentPair[] {
  const n = ref.length
  const m = take.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i * CHORD_GAP_COST
  for (let j = 0; j <= m; j++) dp[0][j] = j * CHORD_GAP_COST
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + chordPairCost(ref[i - 1], take[j - 1]),
        dp[i - 1][j] + CHORD_GAP_COST,
        dp[i][j - 1] + CHORD_GAP_COST,
      )
    }
  }
  const pairs: ChordAlignmentPair[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + chordPairCost(ref[i - 1], take[j - 1])) {
      pairs.unshift({ ref: ref[i - 1], take: take[j - 1] })
      i--
      j--
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + CHORD_GAP_COST) {
      pairs.unshift({ ref: ref[i - 1] })
      i--
    } else {
      pairs.unshift({ take: take[j - 1] })
      j--
    }
  }
  return pairs
}

export type ChordDiagnosis = {
  /** 対応が付いたコードのうちラベルが一致した割合(0〜1) */
  chordMatchRate: number
  /** 対応が付かなかったコード数(抜け+余分) */
  missedOrExtraChordCount: number
  alignedChordCount: number
  /** コードの切り替え時刻の、オフセット・テンポ差を除いた残差の標準偏差(ms) */
  chordChangeJitterMs: number
  pairs: ChordAlignmentPair[]
}

/**
 * 2テイクのコード進行を比べる。音符版の diagnose() と同じ構成:
 * 対応付け → 切り替え時刻に直線を当ててオフセット/テンポ差を除く → 残差の標準偏差。
 */
export function diagnoseChords(refEvents: ChordEvent[], takeEvents: ChordEvent[]): ChordDiagnosis {
  const ref = chordProgression(refEvents)
  const take = chordProgression(takeEvents)
  const pairs = alignChordSequences(ref, take)
  const matched = pairs.filter((p) => p.ref && p.take)
  const labelMatches = matched.filter((p) => p.ref!.label === p.take!.label).length

  const fit = fitLine(
    matched.map((p) => p.ref!.startMs),
    matched.map((p) => p.take!.startMs),
  )
  const residuals = matched.map((p) => (p.take!.startMs - fit.offsetMs) / fit.ratio - p.ref!.startMs)
  const n = residuals.length
  const jitter = n >= 3 ? Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / (n - 2)) : 0

  return {
    chordMatchRate: matched.length ? Number((labelMatches / matched.length).toFixed(3)) : 0,
    missedOrExtraChordCount: pairs.length - matched.length,
    alignedChordCount: matched.length,
    chordChangeJitterMs: Math.round(jitter * 10) / 10,
    pairs,
  }
}

/** 一覧表示用の "C → G → Am" 形式 */
export function formatProgression(events: ChordEvent[], maxItems = 8): string {
  const labels = chordProgression(events).map((e) => e.label)
  if (labels.length === 0) return ''
  const shown = labels.slice(0, maxItems).join(' → ')
  return labels.length > maxItems ? `${shown} …` : shown
}
