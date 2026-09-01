import db, { type DiagnosisResult, type SongThroughCompletion, type Take, type Thread } from '../db'
import { transcribe, warmUpModel } from '../basicPitch'
import { diagnose } from '../comparison'
import { createRng } from './rng'
import { BB_THIRD_FLAT_SHIFTS, DEMO_PHRASES, performPhrase, type DemoPhrase, type SloppinessProfile } from './phrases'
import { synthesizeTake } from './synth'

// 初回起動時のDBは空で、その場で1回録音しても比較対象が無いため診断が出ない。
// このアプリの価値は「数週間の練習の中で伸びているか」なので、時間をまたいだ履歴が無いと何も見せられない。
// そこで発表用に練習履歴を投入するが、診断結果そのものは偽装しない。
// 合成した音声を本番と同じ transcribe() → diagnose() に通し、出てきた値をそのまま保存する。

export type SeedProgress = { step: number; total: number; label: string }

/** デモで作った行はこのprefixで見分ける。newId()ではなく固定idにして、再投入で重複しないようにしている */
const DEMO_ID_PREFIX = 'demo-'

const DAY_MS = 24 * 60 * 60 * 1000

/** 練習時刻。夜に練習している想定にすると履歴の見た目が自然になる */
const PRACTICE_HOUR = 21

function timestampDaysAgo(daysAgo: number, minute: number): number {
  const d = new Date(Date.now() - daysAgo * DAY_MS)
  d.setHours(PRACTICE_HOUR, minute, 0, 0)
  return d.getTime()
}

type DemoTakeSpec = {
  daysAgo: number
  role: 'normal' | 'reference'
  profile: SloppinessProfile
}

type DemoThreadSpec = {
  id: string
  phraseId: string
  status: 'active' | 'resolved'
  /** テイクごとの乱数はこのseedから派生させる(スレッド間で崩れ方が同じにならないように変えてある) */
  rngSeed: number
  takes: DemoTakeSpec[]
  /** 'resolved'のスレッドで、最後の診断に残す自己確認ステップの回答 */
  resolvedSelfCheck?: 'yes' | 'no' | 'unsure'
}

/** 徐々に上達していく様子を作るためのプロファイル生成 */
function sloppiness(
  timingJitterMs: number,
  dropNoteRate: number,
  wrongPitchRate: number,
  extraNoteRate: number,
  velocityJitter: number,
  systematicPitchShifts?: { noteIndex: number; semitones: number }[],
): SloppinessProfile {
  return { timingJitterMs, dropNoteRate, wrongPitchRate, extraNoteRate, velocityJitter, systematicPitchShifts }
}

// シナリオ2の「毎回同じ間違い」。テイク間の崩れ方はほぼ一定=自己比較では非常に安定して見えるが、
// 系統的なズレを含んでいるので、お手本と比べた瞬間にスコアが落ちる。
const CHORD_CHANGE_PROFILE = (timingJitterMs: number): SloppinessProfile =>
  sloppiness(timingJitterMs, 0.01, 0.01, 0.01, 0.15, BB_THIRD_FLAT_SHIFTS)

const PHRASE_THREAD_SPECS: readonly DemoThreadSpec[] = [
  {
    // シナリオ1: 素直に上達している。スコア推移が右肩上がりになるのが狙い
    id: `${DEMO_ID_PREFIX}alt-picking`,
    phraseId: 'alt-picking',
    status: 'active',
    rngSeed: 1101,
    takes: [
      { daysAgo: 20, role: 'normal', profile: sloppiness(55, 0.1, 0.09, 0.08, 0.35) },
      { daysAgo: 17, role: 'normal', profile: sloppiness(47, 0.08, 0.07, 0.06, 0.3) },
      { daysAgo: 13, role: 'normal', profile: sloppiness(39, 0.06, 0.05, 0.05, 0.26) },
      { daysAgo: 10, role: 'normal', profile: sloppiness(30, 0.04, 0.035, 0.035, 0.22) },
      { daysAgo: 5, role: 'normal', profile: sloppiness(22, 0.02, 0.02, 0.02, 0.18) },
      { daysAgo: 1, role: 'normal', profile: sloppiness(15, 0.01, 0.01, 0.01, 0.14) },
    ],
  },
  {
    // シナリオ2(デモの核心): テイク間はほぼ一定=自己比較では「安定している」。
    // ただし全テイクに同じ系統的なズレが入っている。お手本は最近になって追加した設定
    id: `${DEMO_ID_PREFIX}chord-change`,
    phraseId: 'chord-change',
    status: 'active',
    rngSeed: 2203,
    takes: [
      { daysAgo: 18, role: 'normal', profile: CHORD_CHANGE_PROFILE(20) },
      { daysAgo: 14, role: 'normal', profile: CHORD_CHANGE_PROFILE(18) },
      { daysAgo: 11, role: 'normal', profile: CHORD_CHANGE_PROFILE(19) },
      { daysAgo: 6, role: 'normal', profile: CHORD_CHANGE_PROFILE(17) },
      { daysAgo: 2, role: 'normal', profile: CHORD_CHANGE_PROFILE(18) },
      // お手本は正しい押さえ方(systematicPitchShiftsなし)で、ほとんど揺れない演奏
      { daysAgo: 1, role: 'reference', profile: sloppiness(8, 0, 0, 0, 0.08) },
    ],
  },
  {
    // シナリオ3: 単音でクリーンな基礎練。崩れ方は小さい
    id: `${DEMO_ID_PREFIX}chromatic`,
    phraseId: 'chromatic',
    status: 'active',
    rngSeed: 3307,
    takes: [
      { daysAgo: 9, role: 'normal', profile: sloppiness(26, 0.03, 0.025, 0.02, 0.2) },
      { daysAgo: 5, role: 'normal', profile: sloppiness(22, 0.02, 0.015, 0.015, 0.17) },
      { daysAgo: 2, role: 'normal', profile: sloppiness(19, 0.015, 0.01, 0.01, 0.15) },
    ],
  },
  {
    // シナリオ5: 解決済みの履歴。使い込まれている感じを出すためのもの
    id: `${DEMO_ID_PREFIX}vibrato`,
    phraseId: 'vibrato',
    status: 'resolved',
    rngSeed: 4409,
    resolvedSelfCheck: 'yes',
    takes: [
      { daysAgo: 25, role: 'normal', profile: sloppiness(60, 0.1, 0.08, 0.07, 0.33) },
      { daysAgo: 22, role: 'normal', profile: sloppiness(44, 0.06, 0.05, 0.05, 0.27) },
      { daysAgo: 19, role: 'normal', profile: sloppiness(26, 0.03, 0.025, 0.02, 0.2) },
      { daysAgo: 16, role: 'normal', profile: sloppiness(14, 0.01, 0.01, 0.01, 0.13) },
    ],
  },
]

// シナリオ4: 曲通しは簡易ログのみでテイクを作らない。
// 通し時間が少しずつ縮まって落ち着いていく = 演奏が安定してきた、という読み方をする
const SONG_THREAD_ID = `${DEMO_ID_PREFIX}song-through`
const SONG_THREAD_TITLE = '禁じられた遊び'
const SONG_RUNS: readonly { daysAgo: number; durationMs: number; note?: string }[] = [
  { daysAgo: 19, durationMs: 214_800, note: '中盤のアルペジオでつっかえた' },
  { daysAgo: 13, durationMs: 208_300, note: '止まらずに最後まで' },
  { daysAgo: 8, durationMs: 205_100 },
  { daysAgo: 3, durationMs: 203_900, note: 'テンポが安定してきた' },
]

function phraseById(id: string): DemoPhrase {
  const phrase = DEMO_PHRASES.find((p) => p.id === id)
  if (!phrase) throw new Error(`デモフレーズが見つかりません: ${id}`)
  return phrase
}

/**
 * 比較対象は必ず「そのスレッドの1つ前のnormalテイク」とし、compareModeは'prev'で保存する。
 * お手本があるシナリオ2でも'prev'にしているのは、
 *  - お手本は「最近になって追加した」設定なので、過去の診断がprevで残っているのが自然であること
 *  - 一覧のバッジに自己比較のスコアを出しておかないと、デモの山場である
 *    「自己比較では安定 → お手本比較に切り替えるとスコアが落ちる」という反転が見せられないこと
 * の2点による。actions.tsのrunDiagnosisForTakeはお手本を優先するが、ここでは意図的に外している。
 */
function makeDiagnosis(take: Take, prevNormal: Take): DiagnosisResult {
  const metrics = diagnose(prevNormal.noteEvents ?? [], take.noteEvents ?? [])
  return {
    id: `${take.id}-diag`,
    takeId: take.id,
    comparedToTakeId: prevNormal.id,
    compareMode: 'prev',
    ...metrics,
  }
}

let seedInFlight: Promise<{ threadCount: number; takeCount: number }> | null = null
/** 進行中のシードに対する進捗通知先。画面を離れて戻ってきた場合に付け替える */
let activeProgress: ((p: SeedProgress) => void) | undefined

/**
 * デモ用の練習履歴をDBに投入する。
 * 合成音声を実際のtranscribe() → diagnose()に通すので、診断結果は本物である。
 *
 * 投入には1〜2分かかり、その間に画面を離れると進捗表示が消えてボタンが押せる状態に戻る。
 * そこで二重に押されても解析が並列に走らないよう、進行中のPromiseを共有する。
 */
export function seedDemoData(onProgress?: (p: SeedProgress) => void): Promise<{ threadCount: number; takeCount: number }> {
  activeProgress = onProgress
  if (!seedInFlight) {
    seedInFlight = runSeed().finally(() => {
      seedInFlight = null
      activeProgress = undefined
    })
  }
  return seedInFlight
}

async function runSeed(): Promise<{ threadCount: number; takeCount: number }> {
  const takeCount = PHRASE_THREAD_SPECS.reduce((acc, s) => acc + s.takes.length, 0)
  // +1はモデルのウォームアップぶん。ここを数えないと、最初のテイクだけ極端に長い1ステップになる
  const total = takeCount + 1
  let step = 0
  const report = (label: string) => {
    step += 1
    activeProgress?.({ step, total, label })
  }

  // 初回推論はTensorFlow.jsのウォームアップで8秒前後かかる(M1実測)。
  // 先に済ませておかないと、1件目のテイクの進捗表示が固まったように見える。
  // preloadModelではモデルの読み込み(約1.9秒)しか済まず、待ちの大半を占める初回推論が残るため、
  // 捨て推論まで行うwarmUpModelを使う
  report('解析エンジンを準備しています…')
  await warmUpModel()

  for (const spec of PHRASE_THREAD_SPECS) {
    const phrase = phraseById(spec.phraseId)
    // 診断は「1つ前のテイク」との比較なので、必ず古い順に処理する
    const takeSpecs = [...spec.takes].sort((a, b) => b.daysAgo - a.daysAgo)
    const normalCount = takeSpecs.filter((t) => t.role === 'normal').length

    const takeRows: Take[] = []
    const diagnosisRows: DiagnosisResult[] = []
    let normalIndex = 0
    let prevNormal: Take | null = null
    let referenceTakeId: string | undefined
    let lastActivityAt = 0

    for (let i = 0; i < takeSpecs.length; i++) {
      const takeSpec = takeSpecs[i]
      report(
        takeSpec.role === 'reference'
          ? `「${phrase.title}」お手本テイクを解析中`
          : `「${phrase.title}」テイク${normalIndex + 1}/${normalCount} を解析中`,
      )

      const notes = performPhrase(phrase, takeSpec.profile, createRng(spec.rngSeed + i * 977))
      const { blob, audioBuffer, durationMs } = await synthesizeTake(notes)
      // 閾値は既定のまま。本番と同じコードパスを通すことがデモの前提なので、ここで調整はしない
      const { noteEvents, analysisOffsetMs } = await transcribe(audioBuffer)

      const recordedAt = timestampDaysAgo(takeSpec.daysAgo, i * 6)
      const take: Take = {
        id: takeSpec.role === 'reference' ? `${spec.id}-ref` : `${spec.id}-take${normalIndex + 1}`,
        threadId: spec.id,
        role: takeSpec.role,
        audioBlob: blob,
        // お手本は「講師の録音を取り込んだ」設定なので、実際の取り込み経路と同じ値にする
        sourceType: takeSpec.role === 'reference' ? 'importedAudio' : 'demo',
        recordedAt,
        durationMs,
        noteEvents,
        analysisOffsetMs,
      }
      takeRows.push(take)
      lastActivityAt = Math.max(lastActivityAt, recordedAt)

      if (takeSpec.role === 'reference') {
        referenceTakeId = take.id
      } else {
        // 各スレッドの最初のテイクには比較対象が無いので診断を作らない(既存の挙動と同じ)
        if (prevNormal) diagnosisRows.push(makeDiagnosis(take, prevNormal))
        prevNormal = take
        normalIndex += 1
      }
    }

    if (spec.resolvedSelfCheck && diagnosisRows.length > 0) {
      diagnosisRows[diagnosisRows.length - 1].resolvedSelfCheck = spec.resolvedSelfCheck
    }

    const thread: Thread = {
      id: spec.id,
      type: 'phrase',
      title: phrase.title,
      createdAt: timestampDaysAgo(takeSpecs[0].daysAgo, 0),
      lastActivityAt,
      status: spec.status,
      referenceTakeId,
    }

    // スレッド単位でまとめて書く。解析中の中途半端な状態が一覧に見えないようにするため。
    // 固定idの上書きだけでは足りず、先にそのスレッドのテイクを一掃する必要がある。
    // リハーサルでデモスレッドに実際にマイク録音した場合、そのテイクはUUIDなので上書きされず、
    // しかもrecordedAtが「今」なので最新テイクとして残り、スコア推移も一覧のバッジも変わってしまう
    // (「作り直す」を押しても直らない)。テイク数を減らす方向にspecを変えた場合の古い行も同様。
    await db.transaction('rw', db.threads, db.takes, db.diagnosisResults, async () => {
      const staleTakeIds = await db.takes.where('threadId').equals(spec.id).primaryKeys()
      if (staleTakeIds.length) {
        await db.diagnosisResults.where('takeId').anyOf(staleTakeIds).delete()
        await db.takes.bulkDelete(staleTakeIds)
      }
      await db.threads.put(thread)
      await db.takes.bulkPut(takeRows)
      await db.diagnosisResults.bulkPut(diagnosisRows)
    })
  }

  const completions: SongThroughCompletion[] = SONG_RUNS.map((r, i) => ({
    id: `${SONG_THREAD_ID}-run${i + 1}`,
    threadId: SONG_THREAD_ID,
    at: timestampDaysAgo(r.daysAgo, 0),
    durationMs: r.durationMs,
    note: r.note,
  }))
  const songThread: Thread = {
    id: SONG_THREAD_ID,
    type: 'songThrough',
    title: SONG_THREAD_TITLE,
    createdAt: timestampDaysAgo(SONG_RUNS[0].daysAgo, 0),
    lastActivityAt: completions.reduce((acc, c) => Math.max(acc, c.at), 0),
    status: 'active',
  }
  await db.transaction('rw', db.threads, db.songThroughCompletions, async () => {
    await db.songThroughCompletions.where('threadId').equals(SONG_THREAD_ID).delete()
    await db.threads.put(songThread)
    await db.songThroughCompletions.bulkPut(completions)
  })

  return { threadCount: PHRASE_THREAD_SPECS.length + 1, takeCount }
}

/** 全データを削除する(デモのやり直し用) */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.threads, db.takes, db.diagnosisResults, db.songThroughCompletions, async () => {
    await db.threads.clear()
    await db.takes.clear()
    await db.diagnosisResults.clear()
    await db.songThroughCompletions.clear()
  })
}

/**
 * デモデータが「最後まで」投入済みか。
 * prefixが1件でもあればtrue、という判定だと、途中で失敗して中途半端に入った状態でも
 * ボタンが「作り直す」に変わり、投入済みに見えてしまう。
 * 期待するスレッドとテイクが全部そろっていることを条件にする。
 */
export async function hasDemoData(): Promise<boolean> {
  const phraseThreadIds = PHRASE_THREAD_SPECS.map((s) => s.id)
  const threadCount = await db.threads.where('id').anyOf([...phraseThreadIds, SONG_THREAD_ID]).count()
  if (threadCount !== phraseThreadIds.length + 1) return false

  const expectedTakes = PHRASE_THREAD_SPECS.reduce((acc, s) => acc + s.takes.length, 0)
  const takeCount = await db.takes.where('threadId').anyOf(phraseThreadIds).count()
  return takeCount >= expectedTakes
}
