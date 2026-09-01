import { ANALYSIS_SAMPLE_RATE } from '../preprocess'
import { createRng } from './rng'

// デモデータ用の音声合成。診断結果を偽装しないためには「実際に鳴っている音」を
// transcribe()に通す必要があり、そのための音源をコードだけで用意する。
// Karplus-Strongを選んだのは、ノイズ+ディレイライン+1次ローパスという最小の実装で
// 撥弦音らしい倍音構造と自然な減衰が同時に得られ、サンプル音源の同梱が不要になるため。

export type SynthNote = { pitch: number; startMs: number; durationMs: number; velocity?: number }

/** 音符の記譜上の長さを過ぎても弦は鳴り続けるので、その分を足して描画する */
const NOTE_RELEASE_MS = 320
/** 打ち切りによるプチノイズを防ぐための末尾フェード */
const NOTE_FADE_OUT_MS = 90
/** バッファ末尾に残す余白。ここを削ると最後の音の減衰が途中で切れる */
const DEFAULT_TAIL_MS = 600
/** 加算合成後のピーク目標。preprocess側でも正規化されるので、クリップしない値であれば十分 */
const PEAK_TARGET = 0.9
const DEFAULT_VELOCITY = 0.85

// 減衰時間(T60)は音高で変える。実際の弦も高音ほど早く減衰するため、
// 一定にすると高音域が不自然に伸びて音符の切れ目が曖昧になる。
const T60_AT_LOW_PITCH_S = 2.8
const T60_AT_HIGH_PITCH_S = 0.9
const LOW_PITCH = 40 // E2
const HIGH_PITCH = 88 // E6

/** 励起ノイズのシード。合成も決定的でなければデモの再現性が崩れるので固定する */
const EXCITATION_SEED = 20260916

function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

/** y[n] = 0.5*(y[n-N]+y[n-N-1])*decay のdecay。T60(振幅が1/1000になる時間)から逆算する */
function decayPerSample(pitch: number, sampleRate: number): number {
  const ratio = Math.min(1, Math.max(0, (pitch - LOW_PITCH) / (HIGH_PITCH - LOW_PITCH)))
  const t60 = T60_AT_LOW_PITCH_S + (T60_AT_HIGH_PITCH_S - T60_AT_LOW_PITCH_S) * ratio
  return Math.pow(10, -3 / (t60 * sampleRate))
}

/** 1音をKarplus-Strongで生成し、全体バッファへ加算する */
function addNote(out: Float32Array, note: SynthNote, sampleRate: number, rng: ReturnType<typeof createRng>): void {
  const delayLength = Math.max(2, Math.round(sampleRate / midiToFreq(note.pitch)))
  const line = new Float32Array(delayLength)
  for (let i = 0; i < delayLength; i++) line[i] = rng.range(-1, 1)

  const decay = decayPerSample(note.pitch, sampleRate)
  const amp = note.velocity ?? DEFAULT_VELOCITY
  const startSample = Math.max(0, Math.round((note.startMs / 1000) * sampleRate))
  const totalSamples = Math.round(((note.durationMs + NOTE_RELEASE_MS) / 1000) * sampleRate)
  const fadeSamples = Math.max(1, Math.round((NOTE_FADE_OUT_MS / 1000) * sampleRate))

  // prevはy[n-N-1]、line[idx]はy[n-N]にあたる。初期値はノイズの最後尾を使い、
  // 0から始めることで生じる立ち上がりの段差を避ける
  let prev = line[delayLength - 1]
  let idx = 0
  for (let n = 0; n < totalSamples; n++) {
    const target = startSample + n
    if (target >= out.length) break
    const current = line[idx]
    const y = 0.5 * (current + prev) * decay
    line[idx] = y
    prev = current
    idx = idx + 1 === delayLength ? 0 : idx + 1

    const remaining = totalSamples - n
    const fade = remaining < fadeSamples ? remaining / fadeSamples : 1
    out[target] += y * amp * fade
  }
}

/**
 * Karplus-Strong(撥弦弦モデル)で音符列を合成し、モノラルの生サンプルを返す。
 * sampleRateの既定はANALYSIS_SAMPLE_RATEと同じ22050で、こうしておくとpreprocess側の
 * リサンプルがno-opになり、合成した波形がそのまま解析にかかる。
 */
export function renderPluckedString(
  notes: SynthNote[],
  opts?: { sampleRate?: number; tailMs?: number },
): { samples: Float32Array; sampleRate: number } {
  const sampleRate = opts?.sampleRate ?? ANALYSIS_SAMPLE_RATE
  const tailMs = opts?.tailMs ?? DEFAULT_TAIL_MS

  const endMs = notes.reduce((acc, n) => Math.max(acc, n.startMs + n.durationMs + NOTE_RELEASE_MS), 0)
  const length = Math.max(1, Math.ceil(((endMs + tailMs) / 1000) * sampleRate))
  const samples = new Float32Array(length)

  // 音の生成順で乱数列が変わらないよう、時間順に固定してから合成する
  const ordered = [...notes].sort((a, b) => a.startMs - b.startMs)
  const rng = createRng(EXCITATION_SEED)
  for (const note of ordered) addNote(samples, note, sampleRate, rng)

  // 和音では複数の音が重なってピークが1を超えるため、全体をまとめて縮める
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak > 0) {
    const gain = PEAK_TARGET / peak
    for (let i = 0; i < samples.length; i++) samples[i] *= gain
  }

  return { samples, sampleRate }
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/**
 * Float32Array → 16bit PCMのWAV Blob。
 * 保存したBlobはrecording.tsのdecodeAudioBlob(=decodeAudioData)で読み戻され、
 * 再生・再解析に使われるので、素直な44バイトRIFFヘッダ+リニアPCMにしておく。
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2
  const dataBytes = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmtチャンクの長さ(リニアPCMは16固定)
  view.setUint16(20, 1, true) // フォーマットID: 1 = リニアPCM
  view.setUint16(22, 1, true) // モノラル
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // バイト/秒
  view.setUint16(32, bytesPerSample, true) // ブロックサイズ
  view.setUint16(34, 16, true) // ビット深度
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * bytesPerSample, Math.round(clamped * 0x7fff), true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

// AudioBufferコンストラクタはSafariの対応が新しく、また使い捨てのOfflineAudioContextは
// 同時生成数の上限に当たるため、preprocess.tsと同じくサンプリングレートごとに使い回す。
const bufferFactories = new Map<number, OfflineAudioContext>()

function createBuffer(length: number, sampleRate: number): AudioBuffer {
  let factory = bufferFactories.get(sampleRate)
  if (!factory) {
    factory = new OfflineAudioContext(1, 1, sampleRate)
    bufferFactories.set(sampleRate, factory)
  }
  return factory.createBuffer(1, Math.max(1, length), sampleRate)
}

/**
 * 合成して、保存用のWAV Blobと解析用のAudioBufferの両方を返す。
 * 同じ波形からBlobとAudioBufferを作るので、DBに残る音声と診断に使われた音声が必ず一致する
 * (Blobをデコードし直さないぶん、シード実行も速い)。
 */
export async function synthesizeTake(
  notes: SynthNote[],
  opts?: { sampleRate?: number; tailMs?: number },
): Promise<{ blob: Blob; audioBuffer: AudioBuffer; durationMs: number }> {
  const { samples, sampleRate } = renderPluckedString(notes, opts)
  const blob = encodeWav(samples, sampleRate)

  const audioBuffer = createBuffer(samples.length, sampleRate)
  audioBuffer.getChannelData(0).set(samples)

  return { blob, audioBuffer, durationMs: Math.round((samples.length / sampleRate) * 1000) }
}
