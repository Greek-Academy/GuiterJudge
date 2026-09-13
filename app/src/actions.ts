import db, { newId, type Thread, type Take, type NoteEvent, type MetronomeSpec } from './db'
import { Recorder, decodeAudioBlob, extractAudioFromVideoFile } from './recording'
import { transcribe } from './basicPitch'
import { diagnose } from './comparison'
import { mergeSplitNotes } from './noteCleanup'
import { analyzeGridTiming, type GridTiming } from './gridTiming'
import { Metronome, type BeatInfo } from './metronome'

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
  const { noteEvents, analysisOffsetMs, suppressedHarmonicCount } = await transcribe(audioBuffer)

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
  })
  return diagnosisId
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
  return { metrics: diagnose(targetTake.noteEvents, take.noteEvents), comparedToTakeId: targetTake.id }
}

export async function setReferenceTakeFromFile(threadId: string, file: File): Promise<void> {
  const isVideo = file.type.startsWith('video/')
  const audioBlob = isVideo ? await extractAudioFromVideoFile(file) : file
  const audioBuffer = await decodeAudioBlob(audioBlob)
  const { noteEvents, analysisOffsetMs, suppressedHarmonicCount } = await transcribe(audioBuffer)

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
  })
  await db.threads.update(threadId, { referenceTakeId: takeId })
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
 * 取り込んだファイル(案B)は元々テイク履歴に無かったものなので削除するが、
 * 自分の過去テイクを昇格させたもの(案C)は消すと演奏の記録そのものが失われるため、
 * 通常テイクに戻すだけにする。
 */
async function demoteReferenceTake(reference: Take): Promise<void> {
  const wasImported = reference.sourceType === 'importedAudio' || reference.sourceType === 'importedVideo'
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
