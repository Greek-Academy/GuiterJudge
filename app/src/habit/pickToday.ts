import type { Thread, Take, DiagnosisResult } from '../db'
import { startOfDay, daysSince, isHabitTake, warmthLevel } from './dailyStats'

// 「今日の一本」の候補選定(C01)。React にも Dexie にも依存しない純関数。
//
// 日付・今日録ったか・前回テイクの要約は takes / threads の生データから導出する(日付ヘルパーは dailyStats.ts)。
// 判定の核(verdict.ts)が出す「直近テイクの勝敗」「安定ゲージ」と、予告(nextChallenge.ts)は **任意の入力** として受け取り、無ければその優先段を飛ばすだけにする。
// 引き分けやテンポ条件の判定はここには書かない(verdict.ts に 1 か所)。

/** verdict.ts の Outcome | 'n/a' と構造的に同じ。import せずに済むよう手元に置く */
export type HeroOutcome = 'win' | 'draw' | 'loss' | 'n/a'

export type HeroReason = 'challenge' | 'oneMore' | 'setback' | 'stale' | 'next'

export type HeroPick = {
  thread: Thread
  reason: HeroReason
  /** 「前回 9/20: ばらつき 42ms · ♩=80」など 1 行。数字には単位。「上達」「うまく」は使わない */
  line: string
  /** このスレッドを今日すでに録ったか(デモを除く habit テイク基準) */
  doneToday: boolean
  /** 今日このスレッドで録った habit テイクの本数 */
  todayTakeCount: number
  /** 最後に録ってからの日数(暦日差。今日=0、昨日=1) */
  daysSinceLast: number
  /** 安定ゲージの値(0〜5)。gaugeByThread が渡されたときだけ入る */
  gauge?: number
  /** line の元になった最新テイクがデモ音声か(表示側で「デモ」バッジを添える) */
  isDemo: boolean
}

export type HeroState =
  /** アクティブなフレーズスレッドが 0 → 「フレーズを 1 つ登録する」 */
  | { kind: 'empty' }
  /** 先頭が hero。2 番目以降は「別のにする」で回す順番(今日録ったものは末尾) */
  | { kind: 'pick'; picks: HeroPick[] }
  /** 全部今日録音済み。「今日の分は完了。もう 1 本?」+ 次候補 */
  | { kind: 'allDone'; picks: HeroPick[]; todayCount: number }

/** WP-C の NextChallenge と構造的に互換(余分なフィールドがあっても渡せる) */
export type HeroChallenge = { threadId: string; targetJitterMs?: number; bpm?: number }

export type PickTodayArgs = {
  threads: Thread[]
  /** recordedAt 昇順の全テイク(role は混在してよい。ここで normal だけに絞る) */
  takesAsc: Take[]
  /** verdict.latestOutcomeByThread の結果(任意。無ければ「前回悪化」の段を飛ばす) */
  outcomeByThread?: Map<string, HeroOutcome>
  /** verdict.stabilityGauge の value(任意。無ければ「あと 1 本」の段を飛ばす) */
  gaugeByThread?: Map<string, number>
  /** 今日が挑む日の予告(nextChallenge.isChallengeDueToday を通したもの)。任意 */
  challenge?: HeroChallenge | null
  /** takeId → compareMode 'prev' の保存済み診断(任意。メトロノーム無しテイクの「前回比 ◯ms」に使う) */
  prevDiagByTake?: Map<string, DiagnosisResult>
  now?: number
}

/** 安定ゲージの満タン値。verdict.GAUGE_MAX と同値(あと 1 本 = この値 − 1) */
export const HERO_GAUGE_MAX = 5

/** 「今日」「昨日」「3 日前」。責めない中立語のみ(7 節の 6) */
export function daysAgoLabel(days: number): string {
  if (days <= 0) return '今日'
  if (days === 1) return '昨日'
  return `${days} 日前`
}

// ---- スレッドの冷え(C08)。一覧カードの左端バーの色クラス(区切りは dailyStats.warmthLevel) ----

export type WarmthClass = 'warmth-0' | 'warmth-1' | 'warmth-2' | 'warmth-3'

/** `.card` に足すクラス名。温(青)→冷(灰)の 4 段階。14 日以上を畳む扱いは v2 */
export function warmthClass(lastActivityAt: number, now = Date.now()): WarmthClass {
  return `warmth-${warmthLevel(lastActivityAt, now)}`
}

/** 理由バッジの文言。stale だけ日数で変わる */
export function heroReasonLabel(pick: HeroPick): string {
  switch (pick.reason) {
    case 'challenge':
      return '予告'
    case 'oneMore':
      return 'あと 1 本'
    case 'setback':
      return '前回より乱れた'
    case 'stale':
      if (pick.daysSinceLast <= 0) return '今日はまだ'
      if (pick.daysSinceLast === 1) return '昨日に続けて'
      return `${pick.daysSinceLast} 日ぶり`
    case 'next':
      return '次の候補'
  }
}

/** 短い日付「9/20」 */
function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
}

/**
 * 最新テイクのばらつきの要約。
 * メトロノーム録音なら拍に対する絶対値、無ければ直前比(基準が動く値なので「前回比」と書き分ける)。
 * どちらも無ければ本数だけ
 */
function jitterSummary(latest: Take | undefined, count: number, prevDiagByTake?: Map<string, DiagnosisResult>): string {
  if (!latest) return 'まだテイクがありません'
  if (latest.gridTiming && latest.gridTiming.jitterMs >= 0) {
    const bpm = latest.metronome?.bpm ?? latest.gridTiming.bpm
    return `ばらつき ${Math.round(latest.gridTiming.jitterMs)}ms` + (bpm ? ` · ♩=${bpm}` : '')
  }
  const diag = prevDiagByTake?.get(latest.id)
  if (diag) return `前回比 ${Math.round(diag.timingJitterMs)}ms`
  return `${count} テイク`
}

const REASON_RANK: Record<HeroReason, number> = { challenge: 0, oneMore: 1, setback: 2, stale: 3, next: 3 }

export function pickToday(args: PickTodayArgs): HeroState {
  const now = args.now ?? Date.now()
  const today0 = startOfDay(now)
  const active = args.threads.filter((t) => t.type === 'phrase' && t.status === 'active')
  if (active.length === 0) return { kind: 'empty' }

  // スレッドごとに normal テイク(昇順)をまとめる。takesAsc は昇順前提だが、念のため並べ直す
  const normalByThread = new Map<string, Take[]>()
  for (const t of args.takesAsc) {
    if (t.role !== 'normal') continue
    const list = normalByThread.get(t.threadId)
    if (list) list.push(t)
    else normalByThread.set(t.threadId, [t])
  }
  for (const list of normalByThread.values()) list.sort((a, b) => a.recordedAt - b.recordedAt)

  const picks: (HeroPick & { sortKey: [number, number, number] })[] = []
  for (const thread of active) {
    const normals = normalByThread.get(thread.id) ?? []
    const withNotes = normals.filter((t) => !!t.noteEvents)
    const latest = withNotes[withNotes.length - 1] ?? normals[normals.length - 1]
    const habits = normals.filter(isHabitTake)
    const lastHabit = habits[habits.length - 1]
    const todayTakes = habits.filter((t) => t.recordedAt >= today0)
    const doneToday = todayTakes.length > 0
    // 「何日ぶり」は演奏の記録(habit テイク)基準。無ければスレッドの最終更新で代える
    const lastTs = lastHabit?.recordedAt ?? latest?.recordedAt ?? thread.lastActivityAt
    const days = daysSince(lastTs, now)
    const recordedYesterday = lastHabit ? daysSince(lastHabit.recordedAt, now) === 1 : false

    const gauge = args.gaugeByThread?.get(thread.id)
    const outcome = args.outcomeByThread?.get(thread.id)

    let reason: HeroReason
    if (args.challenge && args.challenge.threadId === thread.id) reason = 'challenge'
    else if (gauge === HERO_GAUGE_MAX - 1) reason = 'oneMore'
    else if (outcome === 'loss') reason = 'setback'
    // 今日すでに録ったスレッドに「◯日ぶり」は嘘になるので、理由の無いものは「次の候補」
    else reason = doneToday ? 'next' : 'stale'

    const summary = jitterSummary(latest, normals.length, args.prevDiagByTake)
    let line: string
    if (doneToday) {
      line = `今日 ${todayTakes.length} 本 · 最新は ${summary}`
    } else if (!latest) {
      line = 'まだテイクがありません。最初の 1 本を録ると、次回から前回の自分と比べられます'
    } else if (reason === 'challenge' && args.challenge?.targetJitterMs !== undefined) {
      const bpmText = args.challenge.bpm ? `(♩=${args.challenge.bpm})` : ''
      line = `予告: ${Math.round(args.challenge.targetJitterMs)}ms 以内${bpmText}を狙う · 前回 ${shortDate(latest.recordedAt)}: ${summary}`
    } else {
      line = `前回 ${shortDate(latest.recordedAt)}: ${summary}`
    }

    picks.push({
      thread,
      reason,
      line,
      doneToday,
      todayTakeCount: todayTakes.length,
      daysSinceLast: days,
      gauge,
      isDemo: latest?.sourceType === 'demo',
      // 並び: 今日録ったものは末尾 → 理由の優先順位 → (stale のみ)昨日録ったものは後回し → 最も古いもの。
      // 予告・あと 1 本・前回悪化は「昨日録ったからこそ」の理由なので後回しにしない
      sortKey: [doneToday ? 1 : 0, REASON_RANK[reason] * 2 + (reason === 'stale' && recordedYesterday ? 1 : 0), lastTs],
    })
  }

  picks.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i] - b.sortKey[i]
    }
    return a.thread.title.localeCompare(b.thread.title, 'ja')
  })
  const cleaned: HeroPick[] = picks.map(({ sortKey: _sortKey, ...p }) => p)

  if (cleaned.every((p) => p.doneToday)) {
    // 「今日の分」はスレッドを問わず、今日録った habit テイクの総数
    const todayCount = args.takesAsc.filter((t) => isHabitTake(t) && t.recordedAt >= today0).length
    return { kind: 'allDone', picks: cleaned, todayCount }
  }
  return { kind: 'pick', picks: cleaned }
}
