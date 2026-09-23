import { useMemo, useSyncExternalStore } from 'react'
import type { Take } from '../db'
import { LOW_CONFIDENCE } from '../gridTiming'
import { isHabitTake, startOfDay } from './dailyStats'

// 「明日の予告」(C13)。翌日の起動理由を、前日の自分の数字で仕込む。
//
// 保存先は localStorage の 1 キー(`habit.nextChallenge`、JSON)。Dexie に入れないのは、
// 常に 1 件しかなく数日で消える性質の値で、バックアップ対象にする意味がないから
// (engine.ts の transcribeEngine と同じ扱い)。
//
// 設計上の約束:
//   - 常に 1 件。新しく作ると前の予告は上書きされる(予告の「負債」を作らない)
//   - 3 日たつと無言で消える。未達を数えたり、通知したりしない
//   - 達成/惜しいの判定は次の診断のときに派生値として出すだけで、結果を保存しない

export type NextChallenge = {
  threadId: string
  /** 作った時刻。dayKey(madeAt) の翌日から「今日の一本」候補になる */
  madeAt: number
  /** メトロノーム録音のときだけ入る数値目標(拍に対するばらつき ms。絶対指標なので日をまたいで比べられる) */
  targetJitterMs?: number
  /** 目標 ms を出したときの bpm。同じ bpm で挑む前提で、下げて録った回は達成扱いにしない */
  bpm?: number
}

/** 期限切れは無言で消す(未達を数えない) */
export const CHALLENGE_TTL_DAYS = 3

const KEY = 'habit.nextChallenge'
const DAY_MS = 86_400_000

// --- localStorage の購読(同じタブ内の書き込みも React に伝えるための小さな仕組み) ---
// window の 'storage' イベントは他タブの変更しか飛ばないので、自分の書き込みは独自イベントで通知する。
// summaryDismiss.ts も同じ仕組みを使う(habit の localStorage キーはこの 2 つだけ)。

const HABIT_STORAGE_EVENT = 'habit:storage'

export function notifyHabitStorage(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(HABIT_STORAGE_EVENT))
}

export function subscribeHabitStorage(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('storage', listener)
  window.addEventListener(HABIT_STORAGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', listener)
    window.removeEventListener(HABIT_STORAGE_EVENT, listener)
  }
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** JSON を NextChallenge として検証する。壊れていたら null(古い形式や手編集に耐える) */
function parseChallenge(raw: string | null): NextChallenge | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const o = v as Record<string, unknown>
    if (typeof o.threadId !== 'string' || typeof o.madeAt !== 'number' || !Number.isFinite(o.madeAt)) return null
    const c: NextChallenge = { threadId: o.threadId, madeAt: o.madeAt }
    if (typeof o.targetJitterMs === 'number' && Number.isFinite(o.targetJitterMs)) c.targetJitterMs = o.targetJitterMs
    if (typeof o.bpm === 'number' && Number.isFinite(o.bpm)) c.bpm = o.bpm
    return c
  } catch {
    return null
  }
}

/** 作成から CHALLENGE_TTL_DAYS 日(経過時間)で期限切れ */
export function isChallengeExpired(c: NextChallenge, now = Date.now()): boolean {
  return now - c.madeAt >= CHALLENGE_TTL_DAYS * DAY_MS
}

/** 予告に挑む日の始まり = 作成日の翌日 0:00(ローカル) */
export function challengeDueStart(c: NextChallenge): number {
  const d = new Date(startOfDay(c.madeAt))
  d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * 保存されている予告。期限切れなら null。
 * 当日に作った予告は null にしない(診断画面・まとめで「予告済み」表示に使う)。
 * 読み出しは副作用を持たない(期限切れの掃除は次の set/clear で行う)。
 */
export function readNextChallenge(now = Date.now()): NextChallenge | null {
  const c = parseChallenge(readRaw())
  if (!c || isChallengeExpired(c, now)) return null
  return c
}

/** 今日が挑む日か = 作成日の翌日以降かつ TTL 内。WP-B の hero が「予告」候補にする条件 */
export function isChallengeDueToday(c: NextChallenge, now = Date.now()): boolean {
  return now >= challengeDueStart(c) && !isChallengeExpired(c, now)
}

/** 常に 1 件。既存の予告は上書きする */
export function setNextChallenge(c: NextChallenge): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    // localStorage が使えない環境では予告なしで動く
  }
  notifyHabitStorage()
}

export function clearNextChallenge(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 同上
  }
  notifyHabitStorage()
}

export type ChallengeStatus =
  | { kind: 'none' }
  /** 今日作った(挑む日はまだ来ていない) */
  | { kind: 'planned'; c: NextChallenge }
  /** 今日が挑む日で、まだ対象スレッドを録っていない */
  | { kind: 'due'; c: NextChallenge }
  | { kind: 'fulfilled'; c: NextChallenge; takeId: string; valueMs?: number }
  /** 目標を超えた。「惜しい(+3ms)」。overBy は ms */
  | { kind: 'missed'; c: NextChallenge; takeId: string; valueMs: number; overBy: number }
  /**
   * 録ったが ms 目標を判定しなかった(メトロノーム無し・テンポを下げた・格子が合っていない)。
   * 「遅く弾いて達成」を防ぐための明示的な状態で、未達には数えない。理由は画面に短く出す
   */
  | { kind: 'unjudged'; c: NextChallenge; takeId: string; reason: string }

/**
 * 予告の判定。予告スレッドの habit テイク(デモ・お手本を除く)のうち、
 * 挑む日の 0:00 以降に録った最初の 1 本で決める(何本も録って一番良いのを拾う、はしない)。
 * 数値目標が無い予告は 1 本録れば fulfilled。
 */
export function judgeChallenge(c: NextChallenge | null, takesAsc: Take[], now = Date.now()): ChallengeStatus {
  if (!c || isChallengeExpired(c, now)) return { kind: 'none' }
  const dueStart = challengeDueStart(c)
  if (now < dueStart) return { kind: 'planned', c }

  const take = takesAsc.find((t) => t.threadId === c.threadId && isHabitTake(t) && t.recordedAt >= dueStart)
  if (!take) return { kind: 'due', c }
  if (c.targetJitterMs === undefined) return { kind: 'fulfilled', c, takeId: take.id }

  const g = take.gridTiming
  if (!g) {
    return { kind: 'unjudged', c, takeId: take.id, reason: 'メトロノーム無しの録音のため、ms の目標は判定していません' }
  }
  if (c.bpm !== undefined && g.bpm < c.bpm) {
    return { kind: 'unjudged', c, takeId: take.id, reason: `テンポを落としたため(♩=${g.bpm} < ${c.bpm})達成扱いにしていません` }
  }
  if (g.confidence < LOW_CONFIDENCE) {
    return { kind: 'unjudged', c, takeId: take.id, reason: '音の出だしが格子に乗っておらず、ばらつきの値を信用できないため判定していません' }
  }
  const valueMs = Math.round(g.jitterMs)
  if (valueMs <= c.targetJitterMs) return { kind: 'fulfilled', c, takeId: take.id, valueMs }
  return { kind: 'missed', c, takeId: take.id, valueMs, overBy: valueMs - c.targetJitterMs }
}

/** 予告の目標を 1 語で。「18ms 以内(♩=80)」/「1 本録る」 */
export function formatChallengeTarget(c: NextChallenge): string {
  if (c.targetJitterMs === undefined) return '1 本録る'
  return `${c.targetJitterMs}ms 以内${c.bpm !== undefined ? `(♩=${c.bpm})` : ''}`
}

/**
 * テイクから予告の下書きを作る(診断画面・まとめの「予告する」ボタンの中身)。
 * 目標は「今回と同じ ms 以内」= 同じように弾けるか(一貫性)を狙う。今回より厳しくはしない。
 * 格子が合っていないテイクの ms は信用できないので、そのときは本数だけの予告にする
 */
export function draftChallengeFromTake(take: Pick<Take, 'threadId' | 'gridTiming'>, now = Date.now()): NextChallenge {
  const g = take.gridTiming
  if (g && g.confidence >= LOW_CONFIDENCE) {
    return { threadId: take.threadId, madeAt: now, targetJitterMs: Math.round(g.jitterMs), bpm: g.bpm }
  }
  return { threadId: take.threadId, madeAt: now }
}

/** 保存されている予告を React に載せる。期限切れは null。set/clear で同じタブ内でも再描画される */
export function useNextChallenge(): NextChallenge | null {
  const raw = useSyncExternalStore(subscribeHabitStorage, readRaw, () => null)
  const c = useMemo(() => parseChallenge(raw), [raw])
  if (!c || isChallengeExpired(c)) return null
  return c
}
