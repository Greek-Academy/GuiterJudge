// 蒸留した生徒モデル(train/student.py)の入力になる log-mel スペクトログラムをブラウザで作る。
// 教師・生徒の学習と同じ設定: 16 kHz、n_fft 2048、hop 160(100 フレーム/秒)、周期 Hann 窓、center=True で両端 1024 サンプルを
// 反射パディング、パワースペクトル → 229 本の mel フィルタ(librosa の slaney 正規化、fmin 30、fmax 8000)→ 10·log10(max(x, 1e-10))。
// torch.stft + torchlibrosa の LogmelFilterBank と最大差 1e-3 dB 程度で一致する(train/.venv-hfmt の logmel_cpu と照合済み)。

export const STUDENT_SAMPLE_RATE = 16000
export const N_FFT = 2048
export const HOP = 160
export const N_MELS = 229
export const FRAMES_PER_SECOND = STUDENT_SAMPLE_RATE / HOP

/** mel フィルタ行列(1025 × 229)の非零要素。学習側(torchlibrosa)から書き出したものをそのまま使う */
export type MelFilterbank = { nFft: number; nMels: number; sampleRate: number; entries: [bin: number, mel: number, weight: number][] }

const hann = (() => {
  const w = new Float32Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT) // periodic Hann(torch / librosa の既定)
  return w
})()

// 反復型の複素 FFT(radix-2)。2048 点固定なので回転因子とビット反転表は一度だけ作る
const LOG2N = Math.log2(N_FFT)
const bitrev = (() => {
  const r = new Uint32Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) {
    let x = i, y = 0
    for (let b = 0; b < LOG2N; b++) { y = (y << 1) | (x & 1); x >>= 1 }
    r[i] = y
  }
  return r
})()
const cosTab = new Float64Array(N_FFT / 2), sinTab = new Float64Array(N_FFT / 2)
for (let i = 0; i < N_FFT / 2; i++) { cosTab[i] = Math.cos((2 * Math.PI * i) / N_FFT); sinTab[i] = -Math.sin((2 * Math.PI * i) / N_FFT) }

/** re/im を破壊的に FFT する(長さ N_FFT) */
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < N_FFT; i++) {
    const j = bitrev[i]
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
  }
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1, step = N_FFT / size
    for (let start = 0; start < N_FFT; start += size) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const a = start + k, b = a + half
        const wr = cosTab[tw], wi = sinTab[tw]
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi
      }
    }
  }
}

/** フレーム数。torch.stft(center=True) と同じ 1 + floor(N / hop) */
export function frameCount(numSamples: number): number {
  return 1 + Math.floor(numSamples / HOP)
}

/**
 * 16 kHz モノラルの波形 → log-mel (T × 229、行優先の Float32Array)。
 * 反射パディングは torch の 'reflect'(端のサンプルを繰り返さない: x[1024], x[1023], ..., x[1])。
 */
export function logMelSpectrogram(samples: Float32Array, fb: MelFilterbank): { data: Float32Array; frames: number } {
  if (fb.nFft !== N_FFT || fb.nMels !== N_MELS) throw new Error('mel フィルタの設定が合いません')
  const N = samples.length, pad = N_FFT / 2, T = frameCount(N)
  const padded = new Float32Array(N + 2 * pad)
  for (let i = 0; i < pad; i++) padded[i] = samples[Math.min(pad - i, N - 1)]
  padded.set(samples, pad)
  for (let i = 0; i < pad; i++) padded[pad + N + i] = samples[Math.max(N - 2 - i, 0)]

  // mel ごとの (bin, weight) 一覧に並べ替えておく
  const perMel: { bins: Int32Array; w: Float32Array }[] = []
  const groups: [number, number][][] = Array.from({ length: N_MELS }, () => [])
  for (const [bin, mel, w] of fb.entries) groups[mel].push([bin, w])
  for (const g of groups) perMel.push({ bins: Int32Array.from(g.map((e) => e[0])), w: Float32Array.from(g.map((e) => e[1])) })

  const out = new Float32Array(T * N_MELS)
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), power = new Float64Array(N_FFT / 2 + 1)
  for (let t = 0; t < T; t++) {
    const off = t * HOP
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[off + i] * hann[i]; im[i] = 0 }
    fft(re, im)
    for (let k = 0; k <= N_FFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k]
    for (let m = 0; m < N_MELS; m++) {
      const { bins, w } = perMel[m]
      let acc = 0
      for (let i = 0; i < bins.length; i++) acc += power[bins[i]] * w[i]
      out[t * N_MELS + m] = 10 * Math.log10(Math.max(acc, 1e-10))
    }
  }
  return { data: out, frames: T }
}
