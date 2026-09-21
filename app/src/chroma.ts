// 和音認識(chordRecognition.ts)の入力になるクロマグラム(12音の強さの時系列)を、
// 音声からフーリエ変換で直接計算する。
//
// Basic Pitch はストローク(6音が数十ms以内に立ち上がる)を安定して個々の音符に分解できない
// (Design Doc Appendix B「わかったこと1」)。そこで和音については「どの音が鳴ったか」を
// 音符単位で取るのをやめ、「12音のどこにエネルギーが乗っているか」だけを取る。
// 個々の音の分離が要らないので、フーリエ変換とテンプレート照合だけで済み、学習も要らない。
//
// 周波数分解能と時間分解能の折り合い:
//   ギターの最低音 E2(82Hz) 付近では半音の間隔が約4.9Hz。FFT長 8192 @22050Hz なら
//   1ビン 2.7Hz で半音あたり約2ビン取れる。窓は 371ms と長いが、和音の練習では
//   1コードが数百ms以上続くので、コードの切り替わりを見るには足りる。

export const CHROMA_FRAME_SIZE = 8192
export const CHROMA_HOP_SIZE = 2048

/** クロマに数える周波数帯。下は E2 の少し下、上は5倍音あたりまで(それ以上は音程情報がぼやける) */
const MIN_FREQ_HZ = 75
const MAX_FREQ_HZ = 2100
/**
 * 半音ごとのエネルギーを対数圧縮するときの係数。大きいほど弱い音も拾う(=倍音も拾う)。
 * 合成ストロークでは 10〜30 が安定し 100 で 7th 誤認が増えたが、実録音(GuitarSet の comp 180本)では
 * 40 が 10・20 より 2〜3 ポイント良かった(実際の弦は合成音より倍音が弱く、圧縮を強めても構成音が埋もれない)。
 * 倍音位置からエネルギーを差し引く前処理も試したが改善しなかったので入れていない
 */
export const DEFAULT_LOG_COMPRESSION = 40

export type Chromagram = {
  /** フレームごとの12次元ベクトル(L2正規化済み)。index 0 = C */
  frames: Float32Array[]
  /** フレームごとのRMS(正規化前)。無音フレームの判定に使う */
  rms: number[]
  hopMs: number
  frameMs: number
}

/** 実数入力の反復型 radix-2 FFT。n は2の冪であること。re/im を上書きする */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  // ビット反転並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cRe = 1
      let cIm = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + half] * cRe - im[i + k + half] * cIm
        const bIm = re[i + k + half] * cIm + im[i + k + half] * cRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + half] = aRe - bRe
        im[i + k + half] = aIm - bIm
        const nRe = cRe * wRe - cIm * wIm
        cIm = cRe * wIm + cIm * wRe
        cRe = nRe
      }
    }
  }
}

function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** 各FFTビンが属する半音(MIDI番号)。対象帯域外は -1 */
function binToMidi(frameSize: number, sampleRate: number, maxFreqHz: number): Int16Array {
  const out = new Int16Array(frameSize / 2)
  for (let k = 0; k < out.length; k++) {
    const f = (k * sampleRate) / frameSize
    if (f < MIN_FREQ_HZ || f > maxFreqHz) {
      out[k] = -1
      continue
    }
    out[k] = Math.round(69 + 12 * Math.log2(f / 440))
  }
  return out
}

/**
 * 22050Hz(任意でよいが)モノラルのサンプル列からクロマグラムを計算する。
 * 手順はフレームごとに: Hann窓 → FFT → パワー → 半音ごとに合算 → 対数圧縮 → 12音に畳む → L2正規化。
 * 対数圧縮を半音単位で(12音に畳む前に)かけるのは、低音の基音1つが強いだけで
 * その音のクラスが支配的になるのを抑え、和音の構成音が横並びで見えるようにするため。
 */
export function computeChromagram(
  samples: Float32Array,
  sampleRate: number,
  opts?: { frameSize?: number; hopSize?: number; logCompression?: number; maxFreqHz?: number },
): Chromagram {
  const frameSize = opts?.frameSize ?? CHROMA_FRAME_SIZE
  const hopSize = opts?.hopSize ?? CHROMA_HOP_SIZE
  const logCompression = opts?.logCompression ?? DEFAULT_LOG_COMPRESSION
  const window = hannWindow(frameSize)
  const midiOfBin = binToMidi(frameSize, sampleRate, opts?.maxFreqHz ?? MAX_FREQ_HZ)

  const re = new Float32Array(frameSize)
  const im = new Float32Array(frameSize)
  const pitchEnergy = new Float64Array(128)
  const frames: Float32Array[] = []
  const rms: number[] = []

  // 末尾は足りないぶんをゼロ詰めして最後のフレームまで取る(短い録音で1フレームも出ないことを避ける)
  const frameCount = Math.max(1, Math.ceil(Math.max(0, samples.length - frameSize) / hopSize) + 1)
  for (let fi = 0; fi < frameCount; fi++) {
    const start = fi * hopSize
    let sq = 0
    for (let i = 0; i < frameSize; i++) {
      const s = start + i < samples.length ? samples[start + i] : 0
      sq += s * s
      re[i] = s * window[i]
      im[i] = 0
    }
    rms.push(Math.sqrt(sq / frameSize))
    fftInPlace(re, im)

    pitchEnergy.fill(0)
    let maxPitchEnergy = 0
    for (let k = 0; k < midiOfBin.length; k++) {
      const m = midiOfBin[k]
      if (m < 0) continue
      const p = re[k] * re[k] + im[k] * im[k]
      pitchEnergy[m] += p
      if (pitchEnergy[m] > maxPitchEnergy) maxPitchEnergy = pitchEnergy[m]
    }

    const chroma = new Float32Array(12)
    if (maxPitchEnergy > 0) {
      const denom = Math.log(1 + logCompression)
      for (let m = 0; m < 128; m++) {
        if (pitchEnergy[m] === 0) continue
        chroma[m % 12] += Math.log(1 + (logCompression * pitchEnergy[m]) / maxPitchEnergy) / denom
      }
      let norm = 0
      for (let c = 0; c < 12; c++) norm += chroma[c] * chroma[c]
      norm = Math.sqrt(norm)
      if (norm > 0) for (let c = 0; c < 12; c++) chroma[c] /= norm
    }
    frames.push(chroma)
  }

  return { frames, rms, hopMs: (hopSize / sampleRate) * 1000, frameMs: (frameSize / sampleRate) * 1000 }
}
