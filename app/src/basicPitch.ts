import { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } from '@spotify/basic-pitch'
import type { NoteEvent } from './db'
import { preprocessForAnalysis, ANALYSIS_SAMPLE_RATE, type PreprocessResult } from './preprocess'

// M1予備検証(Appendix B)で確認した、誤検出(倍音を別音符として拾う)を抑えるための閾値。
// 実録音での再検証が必要な、暫定のデフォルト値。TranscriptionLab画面で実データに対して調整する。
export const DEFAULT_ONSET_THRESHOLD = 0.7
export const DEFAULT_FRAME_THRESHOLD = 0.5
export const DEFAULT_MIN_NOTE_FRAMES = 5

export type PitchRange = { min: number; max: number }

/**
 * ギター(標準チューニング6弦)の音域。この範囲外の検出は演奏音ではありえないので落とす。
 *   下限 40 = E2 (6弦開放)
 *   上限 88 = E6。実際の最高音は1弦19フレットのB5(83)だが、ハーモニクスと
 *            チューニングのずれを見込んで余裕を持たせている
 *
 * M1本検証(2026-08-26)で F#6(90) や C7(96) といった明らかに音域外の誤検出が
 * 観測されたことへの対応。倍音由来の誤検出のうち、少なくとも「物理的にありえない音」は
 * 閾値調整に頼らず確実に除去できる。
 *
 * ドロップチューニング・カポ・ギター以外の楽器(PRD M5のおまけ検証)を扱う場合は
 * 呼び出し側で差し替えるか、pitchRange: null で無効化する。
 */
export const GUITAR_PITCH_RANGE: PitchRange = { min: 40, max: 88 }

// CDN依存・オフライン動作の観点から、モデルはpublic/にセルフホストしてService Workerのプリキャッシュ対象にする
const MODEL_URL = `${import.meta.env.BASE_URL}model/model.json`

let modelPromise: Promise<BasicPitch> | null = null

function getModel(): Promise<BasicPitch> {
  if (!modelPromise) {
    const bp = new BasicPitch(MODEL_URL)
    modelPromise = bp.model.then(() => bp)
  }
  return modelPromise
}

/** 初回推論時の待ち時間(Appendix Bで約3秒)を録音前に済ませておきたい場合に使う */
export async function preloadModel(): Promise<void> {
  await getModel()
}

let warmUpPromise: Promise<void> | null = null

/**
 * モデルの読み込みだけでなく「初回の推論」まで済ませておく。
 *
 * M1本検証(2026-08-26)の実測では、初回の内訳は
 *   ライブラリ読込 7.5秒 + モデル読込 1.9秒 + 初回推論 8.2秒
 * で、体感の大半を占めるのは最後の初回推論(TensorFlow.jsのシェーダコンパイル)だった。
 * preloadModelはモデル読込までしか行わないため、これだけでは8秒の待ちは消えない。
 * ここで捨て推論を1回回しておくと、ユーザーが最初に録音したときの待ちが2回目以降の
 * 数百msに落ちる。
 *
 * ウォームアップは「速くするための最適化」でしかないので、失敗してもアプリを止めない。
 * 何度呼んでも1回しか走らない。
 */
export async function warmUpModel(): Promise<void> {
  if (!warmUpPromise) {
    warmUpPromise = (async () => {
      try {
        const model = await getModel()
        // 無音だと前処理側で弾かれてしまうので、微小な振幅の信号を入れる。
        // 長さは1秒あれば全カーネルが一巡するため、これ以上長くしても待ち時間が増えるだけ。
        const ctx = new OfflineAudioContext(1, ANALYSIS_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE)
        const buffer = ctx.createBuffer(1, ANALYSIS_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.sin((2 * Math.PI * 220 * i) / ANALYSIS_SAMPLE_RATE) * 0.2
        }
        await model.evaluateModel(
          buffer,
          () => {},
          () => {},
        )
      } catch {
        // ネットワーク不通やWebGL非対応など。実際の録音時に改めてエラーを出せばよい
      }
    })()
  }
  return warmUpPromise
}

export type NoteExtractionOptions = {
  onsetThreshold?: number
  frameThreshold?: number
  minNoteFrames?: number
  /** 音域フィルタ。未指定ならGUITAR_PITCH_RANGE、nullを渡すとフィルタしない */
  pitchRange?: PitchRange | null
}

/** モデルの生出力。閾値は後処理側のパラメータなので、これを使い回せば閾値スイープに再推論は不要 */
export type RawModelOutput = {
  frames: number[][]
  onsets: number[][]
  contours: number[][]
}

/**
 * 推論のみを行う。入力は22050Hzモノラルであること(preprocessForAnalysisの出力)。
 * 閾値のチューニングでは同じRawModelOutputに対して notesFromModelOutput を繰り返し呼ぶ。
 */
export async function runModel(
  analysisBuffer: AudioBuffer,
  onProgress?: (percent: number) => void,
): Promise<RawModelOutput> {
  const model = await getModel()
  const frames: number[][] = []
  const onsets: number[][] = []
  const contours: number[][] = []

  await model.evaluateModel(
    analysisBuffer,
    (f, o, c) => {
      frames.push(...f)
      onsets.push(...o)
      contours.push(...c)
    },
    (percent) => onProgress?.(percent),
  )

  return { frames, onsets, contours }
}

/** モデル生出力 → 音符列。閾値はここでのみ効く */
export function notesFromModelOutput(raw: RawModelOutput, opts?: NoteExtractionOptions): NoteEvent[] {
  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(
      raw.contours,
      outputToNotesPoly(
        raw.frames,
        raw.onsets,
        opts?.onsetThreshold ?? DEFAULT_ONSET_THRESHOLD,
        opts?.frameThreshold ?? DEFAULT_FRAME_THRESHOLD,
        opts?.minNoteFrames ?? DEFAULT_MIN_NOTE_FRAMES,
      ),
    ),
  )

  const range = opts?.pitchRange === undefined ? GUITAR_PITCH_RANGE : opts.pitchRange

  return filterByPitchRange(
    notes.map((n) => ({
      pitch: n.pitchMidi,
      startMs: Math.round(n.startTimeSeconds * 1000),
      durationMs: Math.round(n.durationSeconds * 1000),
      velocity: n.amplitude,
    })),
    range,
  ).sort((a, b) => a.startMs - b.startMs)
}

/** 音域外の音符を落とす。rangeがnullなら素通し(検証画面でフィルタの効果を測るために使う) */
export function filterByPitchRange(notes: NoteEvent[], range: PitchRange | null): NoteEvent[] {
  if (!range) return notes
  return notes.filter((n) => n.pitch >= range.min && n.pitch <= range.max)
}

export type TranscriptionResult = {
  noteEvents: NoteEvent[]
  /** noteEventsの時刻が元音声より何msぶん前にずれているか(前処理で先頭の無音を捨てた量) */
  analysisOffsetMs: number
  preprocess: Omit<PreprocessResult, 'buffer'>
  timings: { preprocessMs: number; inferenceMs: number; postprocessMs: number }
}

/**
 * DesignDoc Section 5 手順2-3: 前処理 → 音符起こし。
 * 入力は decodeAudioData 直後の任意のサンプリングレート/チャンネル数のAudioBufferでよい。
 */
export async function transcribe(
  audioBuffer: AudioBuffer,
  opts?: NoteExtractionOptions & { onProgress?: (percent: number) => void },
): Promise<TranscriptionResult> {
  const t0 = performance.now()
  const { buffer, ...pre } = await preprocessForAnalysis(audioBuffer)
  const t1 = performance.now()

  if (pre.isSilent) {
    return {
      noteEvents: [],
      analysisOffsetMs: 0,
      preprocess: pre,
      timings: { preprocessMs: t1 - t0, inferenceMs: 0, postprocessMs: 0 },
    }
  }

  const raw = await runModel(buffer, opts?.onProgress)
  const t2 = performance.now()
  const noteEvents = notesFromModelOutput(raw, opts)
  const t3 = performance.now()

  return {
    noteEvents,
    analysisOffsetMs: pre.trimStartMs,
    preprocess: pre,
    timings: { preprocessMs: t1 - t0, inferenceMs: t2 - t1, postprocessMs: t3 - t2 },
  }
}

/** 音符列だけが必要な呼び出し向けの薄いラッパ */
export async function transcribeToNoteEvents(
  audioBuffer: AudioBuffer,
  opts?: NoteExtractionOptions,
): Promise<NoteEvent[]> {
  return (await transcribe(audioBuffer, opts)).noteEvents
}
