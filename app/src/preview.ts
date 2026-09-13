import type { NoteEvent } from './db'
import { mergeSplitNotes } from './noteCleanup'

// ユーザー提案: 「入力した楽譜をプレビュー再生できるように」
// NoteEvent[](ピッチ・開始時刻・長さ)をWeb Audio APIの発振器で単純な音に変換して再生する。
// 目的は「音名を読ませる」代わりに「耳で合っているか確認させる」こと。
// リアルなギター音である必要はなく、音程とタイミングの並びが伝われば十分。

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

let sharedCtx: AudioContext | null = null
function getCtx(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext()
  return sharedCtx
}

export type PreviewOptions = {
  /**
   * true なら分割統合を通さず採譜の生データをそのまま鳴らす(検証画面用)。
   * 既定は統合後。生データには「鳴り続けている音に立った偽オンセット」が約25%含まれ、
   * そのまま鳴らすと同じ音が60〜150ms遅れてダブって聞こえる。診断が使うのは統合後の音符列なので、
   * 通常の再生は診断と同じものを聞かせる。
   */
  raw?: boolean
}

/**
 * NoteEvent[]をプレビュー再生する。
 * 再生中かどうか・完了時刻をハンドリングできるよう、Promiseで完了を返す。
 */
export async function playNoteEvents(rawNotes: NoteEvent[], opts?: PreviewOptions): Promise<void> {
  const notes = opts?.raw ? rawNotes : mergeSplitNotes(rawNotes).notes
  if (notes.length === 0) return
  const ctx = getCtx()
  if (ctx.state === 'suspended') await ctx.resume()

  const startAt = ctx.currentTime + 0.05
  let maxEndSec = 0

  for (const note of notes) {
    const noteStartSec = startAt + note.startMs / 1000
    const noteDurSec = Math.max(note.durationMs / 1000, 0.05)
    const endSec = noteStartSec + noteDurSec
    maxEndSec = Math.max(maxEndSec, endSec)

    const osc = ctx.createOscillator()
    osc.type = 'triangle' // サイン波よりわずかに倍音がありプラック音に近い印象になる
    osc.frequency.value = midiToFreq(note.pitch)

    const gain = ctx.createGain()
    const peak = 0.25 * (note.velocity ?? 0.7)
    // クリックノイズを避けるための短いアタック + 指数的な減衰(プラック音のニュアンス)
    gain.gain.setValueAtTime(0, noteStartSec)
    gain.gain.linearRampToValueAtTime(peak, noteStartSec + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, endSec)

    osc.connect(gain).connect(ctx.destination)
    osc.start(noteStartSec)
    osc.stop(endSec + 0.02)
  }

  const waitMs = Math.max(0, (maxEndSec - ctx.currentTime) * 1000)
  await new Promise((resolve) => setTimeout(resolve, waitMs))
}
