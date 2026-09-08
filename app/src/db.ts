import Dexie, { type EntityTable } from 'dexie'
import type { GridTiming, Subdivision } from './gridTiming'
import { diagnose } from './comparison'

// DesignDoc Section 4「データモデル」に対応する実装。
// deltaMetricsはネストさせず、Dexieで扱いやすいようフラットな型にしている。

/** 録音時のメトロノーム設定。テイクに保存し、スレッドには次回の既定値として覚える */
export type MetronomeSpec = {
  bpm: number
  /** 拍あたりの分割数。演奏の最小音価に合わせる(16分なら4) */
  subdivision: Subdivision
  /** 録音開始からこの拍数はカウントイン。演奏はその次の拍から */
  countInBeats: number
  beatsPerBar: number
}

export type Thread = {
  id: string
  type: 'phrase' | 'songThrough'
  title: string
  createdAt: number
  lastActivityAt: number
  status: 'active' | 'resolved' // songThroughは常時'active'相当(解決概念なし)
  referenceTakeId?: string // role:'reference'のTakeのid(任意)
  /** このスレッドで最後に使ったメトロノーム設定。次の録音の既定値 */
  metronome?: MetronomeSpec
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
  noteEvents?: NoteEvent[] // Basic Pitchでの音符起こし結果(未処理・分割統合前)。統合は解析時に行う
  // 前処理(preprocess.ts)で先頭の無音を捨てた量。noteEventsの時刻はトリム後の時間軸なので、
  // 元のaudioBlobの時間軸に重ねる場合はこの値を足す
  analysisOffsetMs?: number
  /** メトロノームに合わせて録った場合の設定。無ければフリーテンポの録音 */
  metronome?: MetronomeSpec
  /** metronomeがある場合の、拍の格子に対するタイミング解析(比較対象なしで出る絶対指標) */
  gridTiming?: GridTiming | null
}

export type DeviationSegment = { startMs: number; endMs: number; severity: number }

/**
 * 比較対象との相対指標。フィールドは comparison.ts の DiagnosisMetrics と一致させる。
 * 以前あった stabilityScore / timingDriftMs は廃止(理由は comparison.ts の diagnose を参照)。
 */
export type DiagnosisResult = {
  id: string
  takeId: string
  comparedToTakeId: string
  compareMode: 'prev' | 'best' | 'reference'
  noteMatchRate: number
  missedOrExtraNoteCount: number
  alignedNoteCount: number
  mergedNoteCount: number
  timingJitterMs: number
  tempoDiffPct: number
  onsetOffsetMs: number
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

// v2: 診断指標を stabilityScore(合成値) から単位付きの分解指標に置き換えた。
// 診断結果はテイクの noteEvents から決定的に再計算できる派生データなので、
// 保存済みの結果は全件作り直す(比較相手は comparedToTakeId で残っている)。
// インデックスは変えていない。
db.version(2)
  .stores({
    threads: 'id, type, status, lastActivityAt',
    takes: 'id, threadId, role, recordedAt',
    diagnosisResults: 'id, takeId',
    songThroughCompletions: 'id, threadId, at',
  })
  .upgrade(async (tx) => {
    const takes = await tx.table<Take>('takes').toArray()
    const noteEventsById = new Map(takes.map((t) => [t.id, t.noteEvents]))
    const results = await tx.table<DiagnosisResult & { stabilityScore?: number; timingDriftMs?: number }>('diagnosisResults').toArray()
    const rebuilt: DiagnosisResult[] = []
    const orphaned: string[] = []
    for (const r of results) {
      const ref = noteEventsById.get(r.comparedToTakeId)
      const cur = noteEventsById.get(r.takeId)
      if (!ref || !cur) {
        orphaned.push(r.id)
        continue
      }
      rebuilt.push({
        id: r.id,
        takeId: r.takeId,
        comparedToTakeId: r.comparedToTakeId,
        compareMode: r.compareMode,
        resolvedSelfCheck: r.resolvedSelfCheck,
        ...diagnose(ref, cur),
      })
    }
    await tx.table('diagnosisResults').bulkPut(rebuilt)
    if (orphaned.length) await tx.table('diagnosisResults').bulkDelete(orphaned)
  })

export function newId(): string {
  return crypto.randomUUID()
}

export default db
