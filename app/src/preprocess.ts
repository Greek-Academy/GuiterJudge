// DesignDoc Section 5 手順2「前処理」の実装。
// 併せて Basic Pitch の入力要件(22050Hz・モノラル)への適合もここで担う。
// @spotify/basic-pitch の evaluateModel は入力AudioBufferのsampleRateが22050でないと例外を投げるため、
// decodeAudioDataの結果(端末既定の44.1/48kHz)をそのまま渡すことはできない。

/** Basic Pitchが要求する入力サンプリングレート */
export const ANALYSIS_SAMPLE_RATE = 22050

const RMS_FRAME_MS = 20
/** 無音判定のしきい値: 最大RMSに対する相対比。これを下回るフレームを無音とみなす */
const SILENCE_RATIO = 0.06
/** 相対比だけだと「全編ほぼ無音」の録音で誤動作するため、絶対的な下限も併用する */
const SILENCE_FLOOR = 1e-4
/** トリム位置の前後に残す余白。アタックの立ち上がりと減衰の尻尾を切り落とさないため */
const PAD_BEFORE_MS = 60
const PAD_AFTER_MS = 250
/** 正規化の目標振幅。1.0にするとクリップ寸前になるため少し余裕を持たせる */
const NORMALIZE_TARGET = 0.89
/** ピークではなくこの分位点で正規化する(クリック等の単発の外れ値に引きずられないため) */
const NORMALIZE_PERCENTILE = 0.999

export type PreprocessResult = {
  /** 22050Hzモノラル・無音トリム済み・音量正規化済みの解析用バッファ */
  buffer: AudioBuffer
  /** 元音声の先頭から捨てたms数。音符の時刻を元音声の時間軸に戻す際のオフセット */
  trimStartMs: number
  /** 元音声の末尾から捨てたms数 */
  trimEndMs: number
  /** DesignDoc Section4 features.rmsEnvelope。トリム後・正規化前のバッファに対する値 */
  rmsEnvelope: number[]
  rmsFrameMs: number
  /** 正規化で適用したゲイン(テイク間の録音レベル差の指標としても使える) */
  appliedGain: number
  /** 有音区間が見つからなかった場合はtrue。この場合トリム・正規化は行わない */
  isSilent: boolean
}

// AudioBufferコンストラクタはSafariでの対応が新しめなので、確実に使えるOfflineAudioContext経由で作る。
// 解析のたびに使い捨てるとコンテキストが積み上がるため、サンプリングレートごとに使い回す。
// (ここで作るコンテキストはバッファ生成にしか使わないので、長さ1で十分)
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
 * 任意のAudioBufferを22050Hzモノラルへ変換する。
 * ステレオ→モノのダウンミックスはOfflineAudioContextの接続時に自動で行われる。
 */
export async function resampleToAnalysisFormat(
  buffer: AudioBuffer,
  sampleRate: number = ANALYSIS_SAMPLE_RATE,
): Promise<AudioBuffer> {
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === 1) return buffer

  const length = Math.max(1, Math.ceil(buffer.duration * sampleRate))
  const ctx = new OfflineAudioContext(1, length, sampleRate)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start()
  return ctx.startRendering()
}

/** フレーム単位のRMSエンベロープ。無音トリムと、Takeに保存する音量エンベロープの両方に使う */
export function computeRmsEnvelope(data: Float32Array, sampleRate: number, frameMs = RMS_FRAME_MS): number[] {
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const frameCount = Math.ceil(data.length / frameLen)
  const env = new Array<number>(frameCount)
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameLen
    const end = Math.min(start + frameLen, data.length)
    let sum = 0
    for (let i = start; i < end; i++) sum += data[i] * data[i]
    env[f] = Math.sqrt(sum / Math.max(1, end - start))
  }
  return env
}

/** RMSエンベロープから有音区間のフレーム範囲を求める。全編無音ならnull */
function findVoicedFrameRange(env: number[]): { first: number; last: number } | null {
  const peak = env.reduce((a, b) => Math.max(a, b), 0)
  const threshold = Math.max(peak * SILENCE_RATIO, SILENCE_FLOOR)
  let first = -1
  let last = -1
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= threshold) {
      if (first === -1) first = i
      last = i
    }
  }
  return first === -1 ? null : { first, last }
}

/** 外れ値に強い正規化ゲインを求める。無音や極小信号では1を返す(ノイズを増幅しないため) */
function computeNormalizeGain(data: Float32Array): number {
  if (data.length === 0) return 1
  const abs = Float32Array.from(data, Math.abs).sort()
  const ref = abs[Math.min(abs.length - 1, Math.floor(abs.length * NORMALIZE_PERCENTILE))]
  if (ref < SILENCE_FLOOR) return 1
  return NORMALIZE_TARGET / ref
}

/**
 * DesignDoc Section 5 手順2: 無音トリム → 音量正規化。加えてBasic Pitch入力形式への変換。
 *
 * 音符の時刻は「トリム後の時間軸」で返す設計にしている(trimStartMsを足し戻さない)。
 * テイクごとに録音開始から弾き始めるまでの間が違うため、足し戻すと
 * テイク間に一定のオフセットが乗り、comparison.tsのアライメントが不必要に不利になる。
 * 元音声の時間軸が必要な場面のために、捨てた長さはtrimStartMsとして返す。
 */
export async function preprocessForAnalysis(input: AudioBuffer): Promise<PreprocessResult> {
  const resampled = await resampleToAnalysisFormat(input)
  const sr = resampled.sampleRate
  const data = resampled.getChannelData(0)

  const fullEnv = computeRmsEnvelope(data, sr)
  const voiced = findVoicedFrameRange(fullEnv)

  if (!voiced) {
    return {
      buffer: resampled,
      trimStartMs: 0,
      trimEndMs: 0,
      rmsEnvelope: fullEnv,
      rmsFrameMs: RMS_FRAME_MS,
      appliedGain: 1,
      isSilent: true,
    }
  }

  const frameLen = Math.max(1, Math.round((sr * RMS_FRAME_MS) / 1000))
  const padBefore = Math.round((sr * PAD_BEFORE_MS) / 1000)
  const padAfter = Math.round((sr * PAD_AFTER_MS) / 1000)
  const startSample = Math.max(0, voiced.first * frameLen - padBefore)
  const endSample = Math.min(data.length, (voiced.last + 1) * frameLen + padAfter)

  const trimmed = data.subarray(startSample, endSample)
  const gain = computeNormalizeGain(trimmed)

  const out = createBuffer(trimmed.length, sr)
  const outData = out.getChannelData(0)
  for (let i = 0; i < trimmed.length; i++) {
    // 正規化後にクリップしないよう念のため飽和させる
    outData[i] = Math.max(-1, Math.min(1, trimmed[i] * gain))
  }

  return {
    buffer: out,
    trimStartMs: Math.round((startSample / sr) * 1000),
    trimEndMs: Math.round(((data.length - endSample) / sr) * 1000),
    rmsEnvelope: computeRmsEnvelope(trimmed, sr),
    rmsFrameMs: RMS_FRAME_MS,
    appliedGain: gain,
    isSilent: false,
  }
}
