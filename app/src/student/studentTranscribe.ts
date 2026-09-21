// 蒸留した生徒モデル(train/student.py、ONNX)をブラウザ内の ONNX Runtime Web(WASM)で動かす。
// 入力は前処理済み(22050 Hz モノラル)の AudioBuffer。16 kHz に落として 10 秒ごとに log-mel を作り、
// 各セグメントの先頭 1000 フレームをつなぐ(学習側の評価 infer_song と同じ切り方。最後の 1001 フレーム目は捨てる)。
// 出力は onset / frame の確率(T × 88、100 フレーム/秒)。音符化は postprocess.ts。
import * as ort from 'onnxruntime-web/wasm' // WASM 専用ビルド。既定の入口は WebGPU 込み(jsep、28 MB)の WASM を要求する
import { MEL_FILTERBANK } from './melW'
import { logMelSpectrogram, STUDENT_SAMPLE_RATE, N_MELS, HOP } from './logmel'
import { resampleToAnalysisFormat } from '../preprocess'

const MODEL_URL = `${import.meta.env.BASE_URL}student/model.onnx`
const SEGMENT_SAMPLES = 10 * STUDENT_SAMPLE_RATE
const SEGMENT_FRAMES = 1001
const KEEP_FRAMES = 1000
const N_PITCHES = 88

let sessionPromise: Promise<ort.InferenceSession> | null = null

/** モデルの読み込み(初回のみ)。WASM は public/ort/ から。スレッドは 1(計測でスレッドを増やしても変わらず、COOP/COEP も不要になる) */
export function preloadStudentModel(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`
    ort.env.wasm.numThreads = 1
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    sessionPromise.catch(() => (sessionPromise = null))
  }
  return sessionPromise
}

export type StudentRawOutput = { onset: Float32Array; frame: Float32Array; frames: number; inferenceMs: number; featureMs: number }

export async function runStudentModel(analysisBuffer: AudioBuffer): Promise<StudentRawOutput> {
  const session = await preloadStudentModel()
  const buf16 = await resampleToAnalysisFormat(analysisBuffer, STUDENT_SAMPLE_RATE)
  const x = buf16.getChannelData(0)
  const N = x.length
  const T = Math.max(1, Math.ceil(N / HOP))
  const onset = new Float32Array(T * N_PITCHES)
  const frame = new Float32Array(T * N_PITCHES)
  let featureMs = 0, inferenceMs = 0
  const nSeg = Math.max(1, Math.ceil(N / SEGMENT_SAMPLES))
  for (let s = 0; s < nSeg; s++) {
    const base = s * KEEP_FRAMES
    const take = Math.min(KEEP_FRAMES, T - base)
    if (take <= 0) break
    const seg = new Float32Array(SEGMENT_SAMPLES)
    seg.set(x.subarray(s * SEGMENT_SAMPLES, Math.min(N, (s + 1) * SEGMENT_SAMPLES)))
    const t0 = performance.now()
    const { data } = logMelSpectrogram(seg, MEL_FILTERBANK)
    const t1 = performance.now()
    const out = await session.run({ mel: new ort.Tensor('float32', data, [1, SEGMENT_FRAMES, N_MELS]) })
    const t2 = performance.now()
    featureMs += t1 - t0; inferenceMs += t2 - t1
    onset.set((out.onset.data as Float32Array).subarray(0, take * N_PITCHES), base * N_PITCHES)
    frame.set((out.frame.data as Float32Array).subarray(0, take * N_PITCHES), base * N_PITCHES)
  }
  return { onset, frame, frames: T, inferenceMs, featureMs }
}
