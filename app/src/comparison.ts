import type { NoteEvent, DeviationSegment } from './db'

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

export type DiagnosisMetrics = {
  stabilityScore: number
  noteMatchRate: number
  missedOrExtraNoteCount: number
  timingDriftMs: number
  deviationTimeline: DeviationSegment[]
}

/**
 * DesignDoc Section 5 手順6-7: 診断メトリクス算出 + stabilityScoreの合成 + 差分の可視化用データ。
 * 重み付けはM1の技術検証で調整する前提の暫定値。
 */
export function diagnose(ref: NoteEvent[], take: NoteEvent[]): DiagnosisMetrics {
  const pairs = alignNoteSequences(ref, take)
  const matched = pairs.filter((p) => p.ref && p.take)
  const missedOrExtraNoteCount = pairs.length - matched.length

  const pitchMatches = matched.filter((p) => p.ref!.pitch === p.take!.pitch).length
  const noteMatchRate = matched.length ? pitchMatches / matched.length : 0

  const timingDiffs = matched.map((p) => Math.abs(p.take!.startMs - p.ref!.startMs))
  const timingDriftMs = timingDiffs.length
    ? Math.round(timingDiffs.reduce((a, b) => a + b, 0) / timingDiffs.length)
    : 0

  const deviationTimeline: DeviationSegment[] = pairs
    .filter((p) => p.ref)
    .map((p) => {
      let severity = 0
      if (!p.take) severity = 2 // 弾き忘れ
      else if (p.ref!.pitch !== p.take.pitch) severity = 2 // 音程違い
      else if (Math.abs(p.take.startMs - p.ref!.startMs) > 150) severity = 1 // タイミングズレ
      return { startMs: p.ref!.startMs, endMs: p.ref!.startMs + p.ref!.durationMs, severity }
    })

  const rawScore = 100 * noteMatchRate - Math.min(timingDriftMs / 5, 30) - missedOrExtraNoteCount * 8
  const stabilityScore = Math.max(0, Math.min(100, Math.round(rawScore)))

  return {
    stabilityScore,
    noteMatchRate: Number(noteMatchRate.toFixed(3)),
    missedOrExtraNoteCount,
    timingDriftMs,
    deviationTimeline,
  }
}
