import type { NoteEvent } from './db'

// メトロノームに合わせて録ったテイクの、拍の格子に対するタイミング解析。
//
// 「直前のテイクと比較する」方式には、基準がテイクごとに動くという構造的な弱さがある
// (演奏が変わらなくても比較値が動き、最安定テイクの選び方も循環する)。
// BPMが既知なら格子は毎回同じなので、比較対象なしに1テイク単体で
// 「拍に対してどれだけばらついたか」を測れ、テイク間・日をまたいだ比較が素直に成立する。
//
// 格子の位相(録音の中で拍がどこに来るか)は録音開始レイテンシや無音トリムで決まらないため、
// データから推定する(円周統計の平均方向)。位相はデータから取るので
// 「クリックに対して前ノリか後ノリか」という絶対的な偏りは原理的に測れない。
// 測れるのは、ばらつき(jitter)と、格子に対するテンポの流れ(drift)。

/** 拍あたりの分割数。1=4分、2=8分、4=16分、3=3連 */
export type Subdivision = 1 | 2 | 3 | 4

export type GridSpec = { bpm: number; subdivision: Subdivision }

export type GridTiming = {
  bpm: number
  subdivision: Subdivision
  /** 格子1マスの長さ(ms) */
  gridMs: number
  /** 解析に使ったオンセット数 */
  onsetCount: number
  /** 格子に対する残差の標準偏差(ms)。これが「安定度」の本体。小さいほど安定 */
  jitterMs: number
  /** 格子に対するテンポの流れ(%)。正なら次第に速く(格子より前に)なっている */
  tempoDriftPct: number
  /** 位相推定の信頼度(平均合成ベクトル長 0〜1)。0.6未満なら格子が合っていない可能性が高い */
  confidence: number
}

/** 格子に乗っていると判定できる最低音数。これ未満ではSDが意味を持たない */
export const MIN_ONSETS_FOR_GRID = 6
/** confidence がこれ未満なら、選んだ分割やBPMが演奏と合っていないと考える */
export const LOW_CONFIDENCE = 0.6

/** [-g/2, g/2) に折り返す */
function wrapToGrid(x: number, g: number): number {
  const r = ((x % g) + g) % g
  return r >= g / 2 ? r - g : r
}

export function analyzeGridTiming(notes: NoteEvent[], spec: GridSpec): GridTiming | null {
  const gridMs = 60000 / spec.bpm / spec.subdivision
  const onsets = notes.map((n) => n.startMs).sort((a, b) => a - b)
  const n = onsets.length
  if (n < MIN_ONSETS_FOR_GRID) return null

  // 1. 位相: 各オンセットを格子1マス=1周の角度にして平均方向を取る
  let sx = 0
  let sy = 0
  for (const t of onsets) {
    const theta = (2 * Math.PI * (((t % gridMs) + gridMs) % gridMs)) / gridMs
    sx += Math.cos(theta)
    sy += Math.sin(theta)
  }
  const confidence = Math.hypot(sx, sy) / n
  const phaseMs = ((Math.atan2(sy, sx) / (2 * Math.PI)) * gridMs + gridMs) % gridMs

  // 2. 残差(格子からのズレ)。テンポが格子と違うと、時間に比例して残差が流れる
  const residuals = onsets.map((t) => wrapToGrid(t - phaseMs, gridMs))

  // 3. 残差の時間に対する傾き = テンポの流れ。これを引いた後のSDがばらつき
  const mt = onsets.reduce((a, b) => a + b, 0) / n
  const mr = residuals.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (onsets[i] - mt) * (residuals[i] - mr)
    sxx += (onsets[i] - mt) ** 2
  }
  const slope = sxx > 0 ? sxy / sxx : 0 // ms(残差) / ms(経過)
  const icpt = mr - slope * mt
  let ss = 0
  for (let i = 0; i < n; i++) ss += (residuals[i] - (slope * onsets[i] + icpt)) ** 2
  const jitterMs = Math.sqrt(ss / Math.max(1, n - 2))

  return {
    bpm: spec.bpm,
    subdivision: spec.subdivision,
    gridMs: Math.round(gridMs * 10) / 10,
    onsetCount: n,
    jitterMs: Math.round(jitterMs * 10) / 10,
    // 残差が時間に比例して負に流れる = 格子より前に出ていく = 速くなっている
    tempoDriftPct: Math.round(-slope * 100 * 100) / 100,
    confidence: Math.round(confidence * 1000) / 1000,
  }
}
