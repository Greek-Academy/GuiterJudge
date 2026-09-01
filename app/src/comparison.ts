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

  // 対応が付いた音の割合。missedOrExtraNoteCountをそのまま減点に使うと、
  // フレーズが長いほど無条件に不利になる(絶対数なので尺度に依存する)。
  const matchedFraction = pairs.length ? matched.length / pairs.length : 0

  /*
   * スコアの合成。DesignDoc Section 5では暫定値として
   *   100 * noteMatchRate - min(timingDrift/5, 30) - missedOrExtraNoteCount * 8
   * を置いていたが、音符起こしが3割前後の過剰検出を伴う前提の下では、この式は使いものに
   * ならないことがデモデータの実測で判明した。
   *
   * 過剰検出の中身は倍音ではなく「音の分割」である(実測: 検出440音のうち、直前1.2秒以内に
   * 同じ音高が出ているものが25%、倍音関係で説明できるものは0.2%)。前の音が鳴り続けている
   * ところに次の音を弾くと、鳴り続けている音にも新しいオンセットが立つために起きる。
   * 詳細はDesignDoc Appendix B「デモデータによる追加計測」わかったこと4。
   *
   * 実測例(アルペジオ8秒・検出32音): 音高の一致率が1.00でも、どの音が割れるかがテイクごとに
   * 入れ替わるだけで未対応音が8個出て -64点され、スコアは34になった。
   * さらに悪いことに、系統的な間違いを含むお手本比較(一致率0.80)のほうが
   * たまたま未対応音が少なく38点となり、順位が逆転した。
   * つまり分割のゆらぎが、測りたい演奏の差より大きく効いてしまっていた。
   *
   * そこで減点方式をやめ、「基準の音のうち、対応が付いてかつ音高も合っていた割合」に置き換えた。
   *   noteMatchRate      … 対応が付いた音の中で音高が合っていた割合
   *   matchedFraction    … そもそも対応が付いた音の割合
   * 両者の積は尺度に依存せず、過剰検出は matchedFraction を通じて緩やかに効く。
   * 同じデータで自己比較は72〜78、系統的な間違いを含むお手本比較は67となり、
   * 測りたかった差が順位として出るようになった。
   *
   * missedOrExtraNoteCount は指標としては引き続き算出・表示する(何が起きているかは隠さない)。
   */
  const rawScore = 100 * noteMatchRate * matchedFraction - Math.min(timingDriftMs / 5, 30)
  const stabilityScore = Math.max(0, Math.min(100, Math.round(rawScore)))

  return {
    stabilityScore,
    noteMatchRate: Number(noteMatchRate.toFixed(3)),
    missedOrExtraNoteCount,
    timingDriftMs,
    deviationTimeline,
  }
}
