import db, { newId, type Thread, type Take, type NoteEvent, type MetronomeSpec, type DiagnosisResult, type ScoreImportInfo } from './db'
import { Recorder, decodeAudioBlob, extractAudioFromVideoFile } from './recording'
import { transcribe, pitchRangeForTuning } from './basicPitch'
import { diagnose } from './comparison'
import { preprocessForAnalysis } from './preprocess'
import { recognizeChordsFromBuffer, diagnoseChords, type ChordDiagnosis } from './chordRecognition'
import { mergeSplitNotes } from './noteCleanup'
import { analyzeGridTiming, type GridTiming } from './gridTiming'
import { Metronome, type BeatInfo } from './metronome'
import { synthesizeTake } from './synth'
import type { ScoreConversion } from './score'

export async function createPhraseThread(title: string): Promise<string> {
  const id = newId()
  const now = Date.now()
  const thread: Thread = { id, type: 'phrase', title, createdAt: now, lastActivityAt: now, status: 'active' }
  await db.threads.add(thread)
  return id
}

export async function createSongThroughThread(title: string): Promise<string> {
  const id = newId()
  const now = Date.now()
  const thread: Thread = { id, type: 'songThrough', title, createdAt: now, lastActivityAt: now, status: 'active' }
  await db.threads.add(thread)
  return id
}

/** スレッドのメトロノーム既定値を保存する(nullで「メトロノームなし」) */
export async function setThreadMetronome(threadId: string, spec: MetronomeSpec | null): Promise<void> {
  await db.threads.update(threadId, { metronome: spec ?? undefined })
}

/**
 * スレッドの変則調弦の最低音(MIDI)を保存する(null で標準調弦 = E2)。
 * 以後このスレッドで録るテイクの音符起こしは、この音まで音域フィルタを広げる。
 * 保存済みテイクは再解析しない(フィルタで落ちた音は noteEvents に無いので、音声から起こし直すしかない)
 */
export async function setThreadTuningLowest(threadId: string, lowest: number | null): Promise<void> {
  await db.threads.update(threadId, { tuningLowest: lowest ?? undefined })
}

let activeRecorder: Recorder | null = null
let activeMetronome: Metronome | null = null
let activeMetronomeSpec: MetronomeSpec | null = null

/**
 * 録音開始。メトロノーム設定があればカウントインから鳴らし始める。
 * マイクの取得(許可ダイアログを含む)が終わってから鳴らす。逆順だと、
 * ダイアログを見ている間にカウントインが進んでしまう。
 */
export async function startRecording(metronome?: MetronomeSpec | null, onBeat?: (b: BeatInfo) => void): Promise<void> {
  activeRecorder = new Recorder()
  await activeRecorder.start()
  activeMetronomeSpec = metronome ?? null
  if (metronome) {
    activeMetronome = new Metronome(metronome, onBeat)
    await activeMetronome.start()
  }
}

/**
 * メトロノーム録音のテイクの、拍の格子に対するタイミング解析。
 * カウントイン区間(録音先頭から countInBeats 拍)は演奏していないので解析から外す。
 * 区切りは「最後のカウントインと演奏1拍目の中間」。noteEventsの時刻は無音トリム後なので
 * analysisOffsetMs を足して録音の時間軸に戻してから判定する。
 */
export function gridTimingForTake(take: Pick<Take, 'noteEvents' | 'analysisOffsetMs' | 'metronome'>): GridTiming | null {
  if (!take.metronome || !take.noteEvents) return null
  const beatMs = 60000 / take.metronome.bpm
  const cutoffMs = take.metronome.countInBeats * beatMs - beatMs / 2
  const offset = take.analysisOffsetMs ?? 0
  const played = take.noteEvents.filter((n) => n.startMs + offset >= cutoffMs)
  return analyzeGridTiming(mergeSplitNotes(played).notes, take.metronome)
}

/**
 * 録音停止 → 音声保存 → Basic Pitchで音符起こし → (比較対象があれば)診断を実行、まで一気通貫で行う。
 * DesignDoc Section 5のパイプラインのうちステップ1-8をこの関数に集約している。
 */
export async function stopRecordingAndDiagnose(threadId: string): Promise<{ takeId: string; diagnosisId?: string }> {
  if (!activeRecorder) throw new Error('録音が開始されていません')
  activeMetronome?.stop()
  activeMetronome = null
  const metronome = activeMetronomeSpec
  activeMetronomeSpec = null
  const { blob, durationMs } = await activeRecorder.stop()
  activeRecorder = null

  const takeId = newId()
  const audioBuffer = await decodeAudioBlob(blob)
  // 音域フィルタの下限はスレッドの調弦設定(ドロップ D 等)に合わせる
  const thread = await db.threads.get(threadId)
  const { noteEvents, analysisOffsetMs, suppressedHarmonicCount, chordEvents } = await transcribe(audioBuffer, {
    pitchRange: pitchRangeForTuning(thread?.tuningLowest),
  })

  const take: Take = {
    id: takeId,
    threadId,
    role: 'normal',
    audioBlob: blob,
    sourceType: 'recorded',
    recordedAt: Date.now(),
    durationMs,
    noteEvents,
    analysisOffsetMs,
    suppressedHarmonicCount,
    chordEvents,
    metronome: metronome ?? undefined,
  }
  take.gridTiming = gridTimingForTake(take)
  await db.takes.add(take)
  await db.threads.update(threadId, { lastActivityAt: Date.now(), ...(metronome ? { metronome } : {}) })

  const diagnosisId = await runDiagnosisForTake(threadId, take)
  return { takeId, diagnosisId }
}

/**
 * 比較対象の決定(Section5 手順4): デフォルトは直前のテイク。
 * お手本(role:'reference')が設定されていればそちらを優先して比較する。
 */
async function pickComparisonTarget(threadId: string, excludeTakeId: string): Promise<{ take: Take; mode: 'reference' | 'prev' } | null> {
  const reference = await db.takes.where({ threadId, role: 'reference' }).first()
  if (reference && reference.id !== excludeTakeId && reference.noteEvents) {
    return { take: reference, mode: 'reference' }
  }
  const normalTakes = await db.takes.where({ threadId, role: 'normal' }).sortBy('recordedAt')
  const prevTakes = normalTakes.filter((t) => t.id !== excludeTakeId && t.noteEvents)
  if (prevTakes.length === 0) return null
  return { take: prevTakes[prevTakes.length - 1], mode: 'prev' }
}

async function runDiagnosisForTake(threadId: string, take: Take): Promise<string | undefined> {
  const target = await pickComparisonTarget(threadId, take.id)
  if (!target || !take.noteEvents) return undefined

  const metrics = diagnose(target.take.noteEvents!, take.noteEvents)
  const diagnosisId = newId()
  await db.diagnosisResults.add({
    id: diagnosisId,
    takeId: take.id,
    comparedToTakeId: target.take.id,
    compareMode: target.mode,
    ...metrics,
    ...storedChordMetrics(target.take, take),
  })
  return diagnosisId
}

/** DiagnosisResult に保存するコード比較の集計値。両テイクに chordEvents が無ければ空 */
function storedChordMetrics(
  ref: Pick<Take, 'chordEvents'>,
  take: Pick<Take, 'chordEvents'>,
): Pick<DiagnosisResult, 'chordMatchRate' | 'missedOrExtraChordCount' | 'alignedChordCount' | 'chordChangeJitterMs'> {
  if (!ref.chordEvents || !take.chordEvents) return {}
  const c = diagnoseChords(ref.chordEvents, take.chordEvents)
  return {
    chordMatchRate: c.chordMatchRate,
    missedOrExtraChordCount: c.missedOrExtraChordCount,
    alignedChordCount: c.alignedChordCount,
    chordChangeJitterMs: c.chordChangeJitterMs,
  }
}

/**
 * スレッドの「和音の練習」指定を切り替える。
 * ONにしたとき、和音認識の実装前に録ったテイク(chordEvents 無し)があれば、保存してある音声から
 * その場で埋める。Basic Pitch は回さず前処理+FFTだけなので1テイク数十msで済む。
 * 埋めた後は、そのスレッドの保存済み診断にもコード比較の集計値を足す(一覧のバッジ用)。
 */
export async function setThreadChordMode(threadId: string, on: boolean): Promise<void> {
  await db.threads.update(threadId, { chordMode: on })
  if (!on) return
  const takes = await db.takes.where({ threadId }).toArray()
  const byId = new Map(takes.map((t) => [t.id, t]))
  for (const take of takes) {
    if (take.chordEvents) continue
    try {
      const audioBuffer = await decodeAudioBlob(take.audioBlob)
      const { buffer, isSilent } = await preprocessForAnalysis(audioBuffer)
      const chordEvents = isSilent ? [] : recognizeChordsFromBuffer(buffer)
      await db.takes.update(take.id, { chordEvents })
      byId.set(take.id, { ...take, chordEvents })
    } catch (e) {
      // 1テイクの失敗で全体を止めない。そのテイクはコード比較が出ないだけ
      console.warn('和音認識に失敗しました', take.id, e)
    }
  }
  const results = await db.diagnosisResults.where('takeId').anyOf([...byId.keys()]).toArray()
  for (const r of results) {
    if (r.chordMatchRate !== undefined) continue
    const ref = byId.get(r.comparedToTakeId)
    const cur = byId.get(r.takeId)
    if (!ref || !cur) continue
    const patch = storedChordMetrics(ref, cur)
    if (Object.keys(patch).length) await db.diagnosisResults.update(r.id, patch)
  }
}

/**
 * 「最も安定したテイク」の選び方。
 * 以前は保存済みの安定度スコアが最大のテイクを選んでいたが、そのスコアは
 * 「そのテイク自身が隣のテイクとどれだけ似ていたか」なので、基準としては循環していた。
 *
 *  - メトロノーム録音があれば、拍に対するばらつき(絶対指標)が最小のテイク。循環しない。
 *  - 無ければメドイド: 候補どうしの相対ばらつきを総当たりで測り、他の全テイクに対する
 *    ばらつきの中央値が最小のテイク。「一番みんなに似ている=一番代表的な弾き方」を基準にする。
 */
async function pickMostStableTake(threadId: string, excludeTakeId: string): Promise<Take | undefined> {
  const candidates = (await db.takes.where({ threadId, role: 'normal' }).toArray()).filter(
    (t) => t.id !== excludeTakeId && t.noteEvents && t.noteEvents.length > 0,
  )
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  const withGrid = candidates.filter((t) => t.gridTiming && t.gridTiming.jitterMs >= 0)
  if (withGrid.length > 0) {
    return withGrid.reduce((a, b) => (b.gridTiming!.jitterMs < a.gridTiming!.jitterMs ? b : a))
  }

  let best: Take | undefined
  let bestMedian = Infinity
  for (const t of candidates) {
    const others = candidates
      .filter((o) => o.id !== t.id)
      .map((o) => diagnose(t.noteEvents!, o.noteEvents!).timingJitterMs)
      .sort((a, b) => a - b)
    const median = others[Math.floor(others.length / 2)]
    if (median < bestMedian) {
      bestMedian = median
      best = t
    }
  }
  return best
}

/** ComparisonViewでの比較モード切り替え(prev/best/reference)を、その場で再計算する */
export async function recomputeDiagnosis(
  threadId: string,
  takeId: string,
  mode: 'prev' | 'best' | 'reference',
) {
  const take = await db.takes.get(takeId)
  if (!take?.noteEvents) return null

  let targetTake: Take | undefined
  if (mode === 'reference') {
    targetTake = await db.takes.where({ threadId, role: 'reference' }).first()
  } else if (mode === 'prev') {
    // 「直前」は、いま見ているテイクより古いものの中で最も新しいもの。
    // recordedAtの条件を落とすと、過去のテイクを開いたときにスレッドの最新テイクと
    // 比較してしまい、一覧やスコア推移に出ている保存済みの診断値と食い違う
    const normalTakes = (await db.takes.where({ threadId, role: 'normal' }).sortBy('recordedAt')).filter(
      (t) => t.id !== takeId && t.noteEvents && t.recordedAt < take.recordedAt,
    )
    targetTake = normalTakes[normalTakes.length - 1]
  } else if (mode === 'best') {
    targetTake = await pickMostStableTake(threadId, takeId)
  }
  if (!targetTake?.noteEvents) return null
  const chord: ChordDiagnosis | null =
    targetTake.chordEvents && take.chordEvents ? diagnoseChords(targetTake.chordEvents, take.chordEvents) : null
  return { metrics: diagnose(targetTake.noteEvents, take.noteEvents), chord, comparedToTakeId: targetTake.id }
}

export async function setReferenceTakeFromFile(threadId: string, file: File): Promise<void> {
  const isVideo = file.type.startsWith('video/')
  const audioBlob = isVideo ? await extractAudioFromVideoFile(file) : file
  const audioBuffer = await decodeAudioBlob(audioBlob)
  // 録音と同じく、音域フィルタの下限はスレッドの調弦設定に合わせる
  const thread = await db.threads.get(threadId)
  const { noteEvents, analysisOffsetMs, suppressedHarmonicCount, chordEvents } = await transcribe(audioBuffer, {
    pitchRange: pitchRangeForTuning(thread?.tuningLowest),
  })

  // スレッドにつきお手本は1件のみ。既存のものがあれば置き換える。
  // 既存が「過去テイクを昇格させたもの(案C)」の場合は削除せず通常テイクに戻す
  const existing = await db.takes.where({ threadId, role: 'reference' }).first()
  if (existing) await demoteReferenceTake(existing)

  const takeId = newId()
  await db.takes.add({
    id: takeId,
    threadId,
    role: 'reference',
    audioBlob,
    sourceType: isVideo ? 'importedVideo' : 'importedAudio',
    recordedAt: Date.now(),
    durationMs: Math.round(audioBuffer.duration * 1000),
    noteEvents,
    analysisOffsetMs,
    suppressedHarmonicCount,
    chordEvents,
  })
  await db.threads.update(threadId, { referenceTakeId: takeId })
}

/** 変則調弦の最低音の刻み(ThreadDetail の「最低音」セレクトと同じ)。標準調弦 E2 = 40 の下 */
const TUNING_LOWEST_STEPS = [39, 38, 37, 36, 35] as const

/**
 * 楽譜の最低音をスレッドの「最低音」の刻みに丸める(その音が入る一番高い刻み)。
 * B1 = 35 より低い音はセレクトに無いので 35 で止める
 */
export function tuningLowestForScore(lowestPitch: number): number {
  for (const step of TUNING_LOWEST_STEPS) if (step <= lowestPitch) return step
  return TUNING_LOWEST_STEPS[TUNING_LOWEST_STEPS.length - 1]
}

export type ScoreReferenceMeta = {
  fileName: string
  /** 取り込んだ小節範囲(楽譜の小節番号)。全体なら無し */
  measureFrom?: string
  measureTo?: string
}

export type ScoreReferenceResult = {
  takeId: string
  /** 楽譜に標準調弦より低い音があって、スレッドの最低音を下げた場合の新しい値(MIDI) */
  tuningLoweredTo?: number
}

/**
 * DesignDoc Appendix C 入口D: 利用者が持ち込んだ楽譜ファイル(MusicXML / .mxl)をお手本にする。
 * conv は小節範囲の切り出し(sliceMeasures)と BPM の指定(retime)を済ませたもの。
 * 楽譜の音符列をそのまま noteEvents にし(Basic Pitch は通さない。採譜誤差を持ち込まないため)、
 * audioBlob には撥弦音の合成音を入れる(再生・バックアップ・和音認識の再解析の経路をそのまま使うため)。
 * chordEvents は付けない(楽譜から和音名を出すのは Non-goals のコード名自動判定に近い)。
 *
 * 楽譜にスレッドの最低音(既定 E2)より低い音があれば、以後の録音の音域フィルタで
 * その音が捨てられて比較が崩れるので、スレッドの tuningLowest を楽譜の最低音まで下げる。
 */
export async function setReferenceTakeFromScore(
  threadId: string,
  conv: ScoreConversion,
  meta: ScoreReferenceMeta,
): Promise<ScoreReferenceResult> {
  const thread = await db.threads.get(threadId)
  if (!thread) throw new Error('スレッドが見つかりません')
  const notes = conv.notes
  if (notes.length === 0) throw new Error('選んだ範囲に音符がありません')

  const audioBlob = synthesizeTake(notes)
  const endMs = notes.reduce((acc, n) => Math.max(acc, n.startMs + n.durationMs), 0)
  const durationMs = Math.max(Math.round(conv.stats.durationMs), Math.round(endMs))

  const scoreImport: ScoreImportInfo = {
    fileName: meta.fileName,
    title: conv.stats.title || undefined,
    software: conv.stats.software || undefined,
    tempoBpm: Math.round(conv.tempoBpm * 10) / 10,
    tempoSource: conv.tempoSource,
    measureFrom: meta.measureFrom,
    measureTo: meta.measureTo,
    chosenParts: conv.parts.filter((p) => p.chosen).map((p) => p.partName || p.key),
    warnings: conv.warnings.filter((w) => w.level === 'warn').map((w) => w.message),
    notes: notes.length,
  }

  const existing = await db.takes.where({ threadId, role: 'reference' }).first()
  if (existing) await demoteReferenceTake(existing)

  const takeId = newId()
  await db.takes.add({
    id: takeId,
    threadId,
    role: 'reference',
    audioBlob,
    sourceType: 'importedScore',
    recordedAt: Date.now(),
    durationMs,
    noteEvents: notes,
    analysisOffsetMs: 0,
    scoreImport,
  })

  const lowestPitch = notes.reduce((acc, n) => Math.min(acc, n.pitch), Infinity)
  const current = thread.tuningLowest ?? 40
  let tuningLoweredTo: number | undefined
  if (lowestPitch < current) {
    tuningLoweredTo = tuningLowestForScore(lowestPitch)
    if (tuningLoweredTo >= current) tuningLoweredTo = undefined
  }
  await db.threads.update(threadId, {
    referenceTakeId: takeId,
    ...(tuningLoweredTo !== undefined ? { tuningLowest: tuningLoweredTo } : {}),
  })
  return { takeId, tuningLoweredTo }
}

/**
 * DesignDoc Appendix C 案C:「過去テイクをそのままお手本に指定する」。
 * 案B(講師の録音を取り込む)と違って音声の取り込みも音符起こしも不要で、
 * role を 'normal' → 'reference' に切り替えるだけで済む。
 */
export async function setReferenceTakeFromExistingTake(threadId: string, takeId: string): Promise<void> {
  const take = await db.takes.get(takeId)
  if (!take || take.threadId !== threadId) throw new Error('テイクが見つかりません')

  const existing = await db.takes.where({ threadId, role: 'reference' }).first()
  if (existing && existing.id !== takeId) {
    await demoteReferenceTake(existing)
  }

  await db.takes.update(takeId, { role: 'reference' })
  await db.threads.update(threadId, { referenceTakeId: takeId })
}

/** お手本の指定を解除する */
export async function clearReferenceTake(threadId: string): Promise<void> {
  const existing = await db.takes.where({ threadId, role: 'reference' }).first()
  if (existing) await demoteReferenceTake(existing)
  await db.threads.update(threadId, { referenceTakeId: undefined })
}

/**
 * お手本の座から降ろす。
 * 取り込んだファイル(案B)・楽譜から作ったもの(入口D)は元々テイク履歴に無かったものなので削除するが、
 * 自分の過去テイクを昇格させたもの(案C)は消すと演奏の記録そのものが失われるため、
 * 通常テイクに戻すだけにする。
 */
async function demoteReferenceTake(reference: Take): Promise<void> {
  const wasImported =
    reference.sourceType === 'importedAudio' || reference.sourceType === 'importedVideo' || reference.sourceType === 'importedScore'
  if (wasImported) {
    await db.takes.delete(reference.id)
  } else {
    await db.takes.update(reference.id, { role: 'normal' })
  }
}

/** Section6: 「解決済みにする」時の自己確認ステップ */
export async function resolveThread(threadId: string, lastDiagnosisId: string | undefined, selfCheck: 'yes' | 'no' | 'unsure') {
  await db.threads.update(threadId, { status: 'resolved' })
  if (lastDiagnosisId) {
    await db.diagnosisResults.update(lastDiagnosisId, { resolvedSelfCheck: selfCheck })
  }
}

export async function addSongThroughCompletion(threadId: string, durationSec: number, note?: string) {
  await db.songThroughCompletions.add({
    id: newId(),
    threadId,
    at: Date.now(),
    durationMs: Math.round(durationSec * 1000),
    note,
  })
  await db.threads.update(threadId, { lastActivityAt: Date.now() })
}

export type { NoteEvent }
