// 生徒モデルの出力(onset / frame の確率、T × 88、100 フレーム/秒、音高は MIDI 21〜108)→ 音符列。
// train/distill.py の postprocess() と同じ処理。閾値は学習側の採点で決める(v2: onset 0.3、frame ゲート 0.8、frame 閾値 0.3)。
//   1. onset の時間方向の局所最大で onset 閾値以上
//   2. 直後 look フレームの frame の最大がゲート以上(鳴っていない音高の onset を捨てる。生徒の onset は音高の絞り込みが甘い)
//   3. 同じ音高で ±nms フレーム以内は大きいピークだけ残す
//   4. 音の長さは frame ≥ frame 閾値の間(次の onset まで)、最低 minFrames
import type { NoteEvent } from '../db'

export const N_PITCHES = 88
export const PITCH_OFFSET = 21
export type StudentPostprocessOptions = { onsetThreshold: number; frameThreshold: number; frameGate: number; nmsFrames: number; lookFrames: number; minFrames: number }
export const DEFAULT_STUDENT_POSTPROCESS: StudentPostprocessOptions = { onsetThreshold: 0.3, frameThreshold: 0.3, frameGate: 0.8, nmsFrames: 3, lookFrames: 3, minFrames: 2 }

/** onset / frame は行優先 (T × 88)。frameMs は 1 フレームの長さ(10) */
export function notesFromStudentOutput(onset: Float32Array, frame: Float32Array, frames: number, opts: StudentPostprocessOptions = DEFAULT_STUDENT_POSTPROCESS, frameMs = 10): NoteEvent[] {
  const T = frames, P = N_PITCHES
  const notes: NoteEvent[] = []
  for (let p = 0; p < P; p++) {
    const at = (t: number) => onset[t * P + p]
    const cand: number[] = []
    for (let t = 0; t < T; t++) {
      const v = at(t)
      const prev = t > 0 ? at(t - 1) : 0, next = t + 1 < T ? at(t + 1) : 0
      if (!(v >= opts.onsetThreshold && v >= prev && v > next)) continue
      let g = 0
      for (let u = t; u < Math.min(t + opts.lookFrames, T); u++) g = Math.max(g, frame[u * P + p])
      if (g >= opts.frameGate) cand.push(t)
    }
    // 大きいピーク優先(同値は早いほう)で非最大抑制
    cand.sort((a, b) => at(b) - at(a) || a - b)
    const kept: number[] = []
    for (const t of cand) if (kept.every((k) => Math.abs(t - k) > opts.nmsFrames)) kept.push(t)
    kept.sort((a, b) => a - b)
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i], limit = i + 1 < kept.length ? kept[i + 1] : T
      let e = t + 1
      while (e < limit && frame[e * P + p] >= opts.frameThreshold) e++
      e = Math.max(e, Math.min(t + opts.minFrames, T))
      notes.push({ pitch: p + PITCH_OFFSET, startMs: t * frameMs, durationMs: (e - t) * frameMs })
    }
  }
  return notes.sort((a, b) => a.startMs - b.startMs || a.pitch - b.pitch)
}
