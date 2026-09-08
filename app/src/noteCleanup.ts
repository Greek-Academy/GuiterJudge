import type { NoteEvent } from './db'

// 音符起こし結果の後処理。診断に入れる前に「音の分割」を統合する。
//
// Basic Pitchの過剰検出の中身は倍音ではなく「音の分割」である(DesignDoc Appendix B わかったこと4)。
// 前の音が鳴り続けている所に次の音を弾くと、鳴り続けている音にも新しいオンセットが立つ。
// これを診断の入力に残したままだと、演奏が一切変わっていなくても「どの音が割れるか」の
// ゆらぎだけで比較指標が14〜16点動く(検証: 同一演奏12テイクのprev比較で振幅16点)。
// 以前はスコア式(matchedFraction)で吸収しようとしていたが、ノイズ源を式で薄めても
// 信号との比は変わらない。入力側で取り除く。

/**
 * 分割統合の窓。同じ音高の再オンセットがこの間隔以内なら分割とみなし1音に畳む。
 *
 * 「人が意図して同じ音を2回弾く最短間隔」より短く置く必要がある。
 * 150ms = 16分の連打なら bpm100 まで安全(16分1個=150ms)。それより速い連打を含む
 * フレーズでは短くすること。実録音での妥当性は reonsetIntervals() の分布で確認する
 * (分割由来の再オンセットと本物の連打の間に谷があれば、その谷に窓を置く)。
 */
export const SPLIT_MERGE_WINDOW_MS = 150

export type MergeResult = {
  notes: NoteEvent[]
  /** 畳んだ音の数。UIに出して「何個消したか」を隠さない */
  mergedCount: number
}

export function mergeSplitNotes(notes: NoteEvent[], windowMs: number = SPLIT_MERGE_WINDOW_MS): MergeResult {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs)
  const out: NoteEvent[] = []
  const lastByPitch = new Map<number, NoteEvent>()
  let mergedCount = 0

  for (const n of sorted) {
    const prev = lastByPitch.get(n.pitch)
    if (prev && n.startMs - prev.startMs <= windowMs) {
      // 前の音を、後の音の終端まで伸ばす。velocityは強いほうを残す
      prev.durationMs = Math.max(prev.durationMs, n.startMs + n.durationMs - prev.startMs)
      if (n.velocity !== undefined) prev.velocity = Math.max(prev.velocity ?? 0, n.velocity)
      mergedCount += 1
      continue
    }
    const copy = { ...n }
    out.push(copy)
    lastByPitch.set(n.pitch, copy)
  }
  return { notes: out, mergedCount }
}

/**
 * 同じ音高の連続するオンセット間隔(ms)を列挙する。窓の妥当性検証用。
 * 分割由来なら数十〜百数十msに山ができ、本物の連打なら拍に対応する値に山ができるはず。
 */
export function reonsetIntervals(notes: NoteEvent[]): number[] {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs)
  const lastByPitch = new Map<number, number>()
  const intervals: number[] = []
  for (const n of sorted) {
    const prev = lastByPitch.get(n.pitch)
    if (prev !== undefined) intervals.push(n.startMs - prev)
    lastByPitch.set(n.pitch, n.startMs)
  }
  return intervals
}
