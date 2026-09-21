import type { Rng } from './rng'
import type { SynthNote } from './synth'
import type { Subdivision } from '../gridTiming'

// デモで使うフレーズの定義と、「そのフレーズを人間が弾いたらどうブレるか」のモデル。
// フレーズは拍単位で持ち、bpmと組み合わせて実時間に変換する。
// こうしておくと、同じ音符列のまま速度だけ変えたバリエーションを作れる。

/** 拍を単位にしたフレーズ定義(bpmと組み合わせて実時間に変換する) */
export type PhraseNote = { pitch: number; beat: number; beats: number }

export type DemoPhrase = {
  id: string
  title: string
  bpm: number
  /** フレーズに含まれる最小音価(拍あたりの分割数)。拍の格子に対する解析に使う */
  subdivision: Subdivision
  notes: PhraseNote[]
  /** UIに出す短い説明 */
  description: string
}

/** テイクごとの「崩れ方」。値が大きいほど下手に弾いたことになる */
export type SloppinessProfile = {
  timingJitterMs: number
  dropNoteRate: number
  wrongPitchRate: number
  extraNoteRate: number
  velocityJitter: number
  /**
   * 毎回同じ間違いを再現するための固定のズレ。乱数を通さず必ず適用される。
   * PRDのRisksにある「自己比較の構造的限界(同じ間違いを繰り返していてもテイク間の類似度が
   * 高いので"安定している"と誤診断される)」をデモで実演するために使う。
   */
  systematicPitchShifts?: { noteIndex: number; semitones: number }[]
}

// basicPitch.tsのGUITAR_PITCH_RANGEの外に出た音符は解析結果から落とされてしまうので、
// 合成する側でこの範囲に収める。basicPitch.tsをimportするとTensorFlow.jsまで巻き込むため、
// ここでは値だけを持つ(範囲を変えるときは両方を合わせること)。
const MIN_PITCH = 40 // E2
const MAX_PITCH = 88 // E6

const BASE_VELOCITY = 0.85

function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.round(pitch)))
}

/** 等間隔の音符列。beatsを省略すると次の音符まで鳴り続ける長さになる */
function run(pitches: readonly number[], startBeat: number, step: number, beats: number = step): PhraseNote[] {
  return pitches.map((pitch, i) => ({ pitch, beat: startBeat + i * step, beats }))
}

// --- シナリオ1: 16分のオルタネイト -------------------------------------------
// Aマイナーペンタトニックの5〜8フレットのボックス(いわゆる1ポジション)を上下する定番の運指。
// A2(6弦5フレット)から始まる実際の運指の音を並べている。
// 当初1オクターブ上の音を置いていたが、それは17フレット付近のポジションであり、
// 画面に出るタイトル「5〜8フレット」と食い違っていた。
const AM_PENTATONIC_UP = [45, 48, 50, 52, 55, 57, 60, 62, 64, 67, 69]
const AM_PENTATONIC_RUN = [...AM_PENTATONIC_UP, ...AM_PENTATONIC_UP.slice(0, -1).reverse()]

// --- シナリオ2: F→B♭の押さえ替え --------------------------------------------
// 当初は6音のバレーコードを同時に鳴らすストロークにしていたが、実機で試したところ
// Basic Pitchが和音を安定して分解できず、テイクごとに検出音がばらついて
// 安定度スコアが0に張り付いた(M1で「和音は未検証」としていた懸念が現実になった形)。
// アルペジオ(分散和音)にして音を時間方向に分ければ、押さえ替えという練習内容は保ったまま
// 音符起こしが安定する。これは素材側の都合ではなく、現在のエンジンで扱える範囲の話なので、
// 発表では「単音・分散和音までが現状の守備範囲」という所見としてそのまま話せる。
const F_ARPEGGIO = [53, 57, 60, 65] // F3 A3 C4 F4
const BB_ARPEGGIO = [58, 62, 65, 70] // A#3 D4 F4 A#4

/**
 * B♭の3度(D4)はB♭アルペジオの2番目の音。F→B♭を3往復するので、
 * B♭のブロックは全体のindex 4・12・20から始まり、D4はその1つ後ろ=5・13・21になる。
 * ここを半音下げると「B♭を押さえるたびに3度だけ半音低い」= 毎回同じ押さえ間違いになる。
 * seed.tsのシナリオ2でSloppinessProfileに渡す。
 */
export const BB_THIRD_FLAT_SHIFTS = [
  { noteIndex: 5, semitones: -1 },
  { noteIndex: 13, semitones: -1 },
  { noteIndex: 21, semitones: -1 },
]

// --- シナリオ6: G→C→D→G のストローク(和音認識のデモ) --------------------------
// 和音認識(chordRecognition.ts)を入れたことで、ストロークも「コード進行」としてなら診断できるようになった。
// 6弦を14ms間隔で弾き下ろす。音符起こしはここでは崩れるが、それ自体が
// 「音符単位は無理でもコード単位なら取れる」という見せ方になる。
const G_OPEN = [43, 47, 50, 55, 59, 67]
const C_OPEN = [48, 52, 55, 60, 64]
const D_OPEN = [50, 57, 62, 66]
/** ストロークの弦間隔(拍)。bpm 80 で約14ms */
const STRUM_STEP_BEATS = 0.019

function strum(pitches: readonly number[], startBeat: number, beats: number): PhraseNote[] {
  return pitches.map((pitch, i) => ({ pitch, beat: startBeat + i * STRUM_STEP_BEATS, beats: beats - i * STRUM_STEP_BEATS }))
}

// --- シナリオ3: クロマチック上行 ---------------------------------------------
// 6弦→1弦へ各弦1〜4フレットを順に。基礎練らしく単音でクリーンな素材にしている。
const CHROMATIC_UP = [
  41, 42, 43, 44, // 6弦
  46, 47, 48, 49, // 5弦
  51, 52, 53, 54, // 4弦
  56, 57, 58, 59, // 3弦
  60, 61, 62, 63, // 2弦
  65, 66, 67, 68, // 1弦
]

// テンポと音符の数は「1テイク6〜9秒」に収まるよう決めている(18テイクぶんの解析時間を抑えるため)。
export const DEMO_PHRASES: readonly DemoPhrase[] = [
  {
    id: 'alt-picking',
    // bpm84の16分(1音178ms)では音が詰まりすぎてBasic Pitchが取りこぼしたため、
    // 練習テンポとして現実的な範囲でbpmを落とし、1音あたり約260msを確保している
    title: '16分のオルタネイト（Amペンタ 5〜8フレット）',
    bpm: 58,
    subdivision: 4,
    notes: run(AM_PENTATONIC_RUN, 0, 0.25),
    description: 'Amペンタの1ポジションを16分で1往復。メトロノームを落として粒を揃える練習。',
  },
  {
    id: 'chord-change',
    title: 'F→B♭ の押さえ替え（アルペジオ）',
    bpm: 96,
    subdivision: 2,
    notes: [
      ...run(F_ARPEGGIO, 0, 0.5),
      ...run(BB_ARPEGGIO, 2, 0.5),
      ...run(F_ARPEGGIO, 4, 0.5),
      ...run(BB_ARPEGGIO, 6, 0.5),
      ...run(F_ARPEGGIO, 8, 0.5),
      ...run(BB_ARPEGGIO, 10, 0.5),
    ],
    description: 'バレーコード同士の押さえ替えを、アルペジオで2拍ごとに3往復。',
  },
  {
    id: 'strum',
    title: 'G→C→D→G のストローク',
    bpm: 80,
    subdivision: 1,
    notes: [
      ...strum(G_OPEN, 0, 2),
      ...strum(C_OPEN, 2, 2),
      ...strum(D_OPEN, 4, 2),
      ...strum(G_OPEN, 6, 2),
    ],
    description: '開放弦コードを2拍ずつ弾き下ろす。和音認識でコード進行と切り替えのタイミングを見る。',
  },
  {
    id: 'chromatic',
    title: 'クロマチック上行（基礎練）',
    bpm: 96,
    subdivision: 2,
    notes: run(CHROMATIC_UP, 0, 0.5),
    description: '6弦から1弦まで1〜4フレットを8分で上行する基礎練習。',
  },
  {
    id: 'vibrato',
    title: '1弦12フレットのビブラート',
    bpm: 76,
    subdivision: 2,
    notes: [
      { pitch: 76, beat: 0, beats: 1 },
      { pitch: 74, beat: 1, beats: 0.5 },
      { pitch: 76, beat: 1.5, beats: 0.5 },
      { pitch: 79, beat: 2, beats: 1 },
      { pitch: 76, beat: 3, beats: 2 },
      { pitch: 74, beat: 5, beats: 0.5 },
      { pitch: 72, beat: 5.5, beats: 0.5 },
      { pitch: 76, beat: 6, beats: 2.5 },
    ],
    description: '1弦12フレットのE音をロングトーンで伸ばすフレーズ。',
  },
]

/** フレーズ定義 + 崩れ方 + 乱数 から、実際に「弾かれた」音符列を作る */
export function performPhrase(phrase: DemoPhrase, profile: SloppinessProfile, rng: Rng): SynthNote[] {
  const msPerBeat = 60000 / phrase.bpm
  const shifts = new Map<number, number>()
  for (const s of profile.systematicPitchShifts ?? []) shifts.set(s.noteIndex, s.semitones)

  const played: SynthNote[] = []

  phrase.notes.forEach((note, index) => {
    const systematic = shifts.get(index)

    // 系統的なズレは「毎回同じ間違いを安定して弾いている」ことを見せるためのものなので、
    // 弾き損ないでその音自体が消えると意味がなくなる。該当音は落とさない。
    if (systematic === undefined && rng.bool(profile.dropNoteRate)) return

    let pitch = note.pitch + (systematic ?? 0)
    // 押さえ違いは隣のフレット(=半音)に外すのが実際に多いパターン。
    // 系統的なズレを与えた音は、その上に偶発的なズレが乗ると「毎回同じ音を間違えている」が
    // 崩れてしまうので対象から外す
    if (systematic === undefined && rng.bool(profile.wrongPitchRate)) pitch += rng.bool(0.5) ? 1 : -1

    const startMs = Math.max(0, note.beat * msPerBeat + rng.range(-profile.timingJitterMs, profile.timingJitterMs))
    // 音の長さのばらつきは短めに倒す(下手なときほど音が切れやすい)
    const durationMs = Math.max(60, note.beats * msPerBeat * rng.range(0.82, 1.04))
    const velocity = Math.min(
      1,
      Math.max(0.25, BASE_VELOCITY * (1 + rng.range(-profile.velocityJitter, profile.velocityJitter))),
    )

    played.push({ pitch: clampPitch(pitch), startMs, durationMs, velocity })

    if (rng.bool(profile.extraNoteRate)) {
      // 隣の弦に当たってしまった余計な音。短く弱く、狙った音の少し後ろに出る
      played.push({
        pitch: clampPitch(pitch + rng.pick([-5, -4, 4, 5])),
        startMs: startMs + durationMs * 0.35,
        durationMs: Math.min(durationMs * 0.5, 200),
        velocity: velocity * 0.5,
      })
    }
  })

  return played.sort((a, b) => a.startMs - b.startMs)
}
