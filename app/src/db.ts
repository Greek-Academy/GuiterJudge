import Dexie, { type EntityTable } from 'dexie'

// DesignDoc Section 4「データモデル」に対応する実装。
// deltaMetricsはネストさせず、Dexieで扱いやすいようフラットな型にしている。

export type Thread = {
  id: string
  type: 'phrase' | 'songThrough'
  title: string
  createdAt: number
  lastActivityAt: number
  status: 'active' | 'resolved' // songThroughは常時'active'相当(解決概念なし)
  referenceTakeId?: string // role:'reference'のTakeのid(任意)
}

export type NoteEvent = { pitch: number; startMs: number; durationMs: number; velocity?: number }

export type Take = {
  id: string
  threadId: string
  role: 'normal' | 'reference' // 'reference' = お手本(講師録音等)。スレッドにつき任意で1件
  audioBlob: Blob
  // 'demo' = デモ用に合成した音声。実際の解析パイプラインは通しているが、
  // 人間が弾いた録音ではないことを区別できるようにしておく
  sourceType: 'recorded' | 'importedAudio' | 'importedVideo' | 'demo'
  recordedAt: number
  durationMs: number
  noteEvents?: NoteEvent[] // Basic Pitchでの音符起こし結果(未処理の場合はundefined)
  // 前処理(preprocess.ts)で先頭の無音を捨てた量。noteEventsの時刻はトリム後の時間軸なので、
  // 元のaudioBlobの時間軸に重ねる場合はこの値を足す
  analysisOffsetMs?: number
}

export type DeviationSegment = { startMs: number; endMs: number; severity: number }

export type DiagnosisResult = {
  id: string
  takeId: string
  comparedToTakeId: string
  compareMode: 'prev' | 'best' | 'reference'
  stabilityScore: number
  noteMatchRate: number
  missedOrExtraNoteCount: number
  timingDriftMs: number
  deviationTimeline: DeviationSegment[]
  resolvedSelfCheck?: 'yes' | 'no' | 'unsure' // Section6「解決済みにする」時の自己確認ステップの回答
}

export type SongThroughCompletion = {
  id: string
  threadId: string
  at: number
  durationMs: number
  note?: string
}

const db = new Dexie('GuitarDiagnosisDB') as Dexie & {
  threads: EntityTable<Thread, 'id'>
  takes: EntityTable<Take, 'id'>
  diagnosisResults: EntityTable<DiagnosisResult, 'id'>
  songThroughCompletions: EntityTable<SongThroughCompletion, 'id'>
}

db.version(1).stores({
  threads: 'id, type, status, lastActivityAt',
  takes: 'id, threadId, role, recordedAt',
  diagnosisResults: 'id, takeId',
  songThroughCompletions: 'id, threadId, at',
})

export function newId(): string {
  return crypto.randomUUID()
}

export default db
