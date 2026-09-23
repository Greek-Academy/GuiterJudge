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

/**
 * windowMs に関数を渡すと音高ごとに窓を変えられる(楽譜由来のお手本と比べる時に、お手本に速い同音連打がある音高だけ窓を縮める。
 * splitWindowForScoreReference)。
 */
export function mergeSplitNotes(
  notes: NoteEvent[],
  windowMs: number | ((pitch: number) => number) = SPLIT_MERGE_WINDOW_MS,
): MergeResult {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs)
  const out: NoteEvent[] = []
  const lastByPitch = new Map<number, NoteEvent>()
  let mergedCount = 0
  const windowFor = typeof windowMs === 'function' ? windowMs : () => windowMs

  for (const n of sorted) {
    const prev = lastByPitch.get(n.pitch)
    if (prev && n.startMs - prev.startMs <= windowFor(n.pitch)) {
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

/** 同時刻(1ms 以内)に鳴る同じ音高を 1 音にまとめる窓。楽譜の多声部のユニゾン(同じ音を 2 声部で書いたもの)用 */
export const UNISON_WINDOW_MS = 1

/**
 * 楽譜由来のお手本と比べる時の、テイク側の分割統合の窓(音高ごと)。
 *
 * 楽譜の同音連打(16 分・32 分の連打、トレモロ)は格子どおりに 150ms 以内で並ぶことがあり、両側を 150ms で畳むと
 * 連打がまるごと 1 音になって診断の対象から消える(GAPS の連打を含む 4 小節 479 区間で、連打の 2 音目以降の正しい対応 16%)。
 * かといってお手本側だけ畳まないと、テイク側では畳まれて「弾き忘れ」が倍増する(同 弾き忘れ+余分 13% → 25%)。
 * そこでお手本(楽譜)は同時刻の重複だけ除き、テイク側は「お手本でその音高が連打される最短間隔」の半分
 * (テイクのテンポに換算)まで窓を縮める。お手本に連打の無い音高は従来どおり 150ms。
 * テンポ比はテイク全体の長さ比(両方 4 音以上・1 秒以上の時だけ。0.4〜2.5 に制限)で見積もる。
 */
export function splitWindowForScoreReference(reference: NoteEvent[], take: NoteEvent[]): (pitch: number) => number {
  const ref = [...reference].sort((a, b) => a.startMs - b.startMs)
  const tk = [...take].sort((a, b) => a.startMs - b.startMs)
  let scale = 1
  if (ref.length >= 4 && tk.length >= 4) {
    const spanRef = ref[ref.length - 1].startMs - ref[0].startMs
    const spanTake = tk[tk.length - 1].startMs - tk[0].startMs
    if (spanRef >= 1000 && spanTake >= 1000) scale = Math.max(0.4, Math.min(2.5, spanTake / spanRef))
  }
  const minRepeat = new Map<number, number>()
  const last = new Map<number, number>()
  for (const n of ref) {
    const prev = last.get(n.pitch)
    const gap = prev === undefined ? undefined : n.startMs - prev
    if (gap !== undefined && gap > UNISON_WINDOW_MS) minRepeat.set(n.pitch, Math.min(minRepeat.get(n.pitch) ?? Infinity, gap))
    last.set(n.pitch, n.startMs)
  }
  return (pitch) => {
    const r = minRepeat.get(pitch)
    return r === undefined ? SPLIT_MERGE_WINDOW_MS : Math.min(SPLIT_MERGE_WINDOW_MS, 0.5 * r * scale)
  }
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
