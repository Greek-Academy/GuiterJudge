import type { NoteEvent } from './db'

// 「全音符の途中に音が紛れ込む」への対策。
//
// Basic Pitch の outputToNotesPoly は音符を2経路で作る。
//   1. オンセット確率のピークから伸ばす(ピッキングの瞬間があるもの)
//   2. melodiaTrick: 1で消費されずに残ったフレーム活性がしきい値を超えていれば、
//      オンセットが無くてもそこを起点に前後へ伸ばす
// 長く鳴っている音の倍音(+12/+19/+24/+28…半音)のビンに活性が乗ると、2の経路で
// 「ピッキングしていないのに音符が生まれる」。これを実録音で観測した(2026-09-13)。
//
// オンセットの有無は区別できる(melodiaTrick 無しで後処理をもう一度回し、そこに無い音符が
// オンセット無し)。そのうえで「オンセット無し × 鳴っている下の音の倍音関係」だけを捨てる。
// オンセットがある音符は一切触らない。ベース音の上でオクターブを弾くのは普通の奏法なので、
// 倍音関係だけで捨てると本物を殺す。オンセット無しでも倍音関係にない音(ハンマリング、
// スライドで生まれる音)は残す。

export type TaggedNote = NoteEvent & { hasOnset: boolean }

/** 基音からの半音数。2〜8倍音(7倍音は33.7半音なので34に丸まる) */
export const HARMONIC_INTERVALS = [12, 19, 24, 28, 31, 34, 36]

/**
 * 検出上は基音が「終わった」後も弦は物理的に鳴り続けている(フレームしきい値で
 * 尻尾が切れる)ので、基音の終端からこの時間以内に立った倍音も対象にする
 */
export const SUSTAIN_GRACE_MS = 250

export type HarmonicFilterResult = { kept: TaggedNote[]; suppressed: TaggedNote[] }

export function suppressHarmonics(notes: TaggedNote[]): HarmonicFilterResult {
  const sorted = [...notes].sort((a, b) => a.startMs - b.startMs)
  const kept: TaggedNote[] = []
  const suppressed: TaggedNote[] = []
  for (const n of sorted) {
    if (n.hasOnset) {
      kept.push(n)
      continue
    }
    // 基音候補は「残した音符」の中から探す。捨てた倍音を基音にして連鎖させない
    // (F の +24 は F 自身から直接見つかる)
    const fundamental = kept.find(
      (f) =>
        f.startMs < n.startMs &&
        f.startMs + f.durationMs + SUSTAIN_GRACE_MS > n.startMs &&
        HARMONIC_INTERVALS.includes(n.pitch - f.pitch),
    )
    if (fundamental) suppressed.push(n)
    else kept.push(n)
  }
  return { kept, suppressed }
}
