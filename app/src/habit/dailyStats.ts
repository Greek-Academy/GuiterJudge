import type { Take } from '../db'

// 「日」の集計に使う純関数。すべてローカル時刻基準(ユーザーが見ている日付と一致させる)。
// UTC 基準にすると日本では 9 時にならないと「今日」が変わらず、深夜の練習が前日に入ってしまう。

const DAY_MS = 86_400_000

/** ローカルの今日 0:00 の epoch ms */
export function startOfToday(now = Date.now()): number {
  return startOfDay(now)
}

/** 任意の時刻が属するローカル日の 0:00 */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 'YYYY-MM-DD'(ローカル)。localStorage のキーや「同じ日か」の比較に使う */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * カレンダー上の日数差(今日=0、昨日=1)。経過時間ではなく日付の差にしているのは、
 * 「昨日の 23 時に録った」を 2 時間後に見ても「1 日前」と読ませたいから。
 * 夏時間などで 1 日が 24 時間でない日があっても四捨五入で吸収する。
 */
export function daysSince(ts: number, now = Date.now()): number {
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS))
}

/**
 * 「毎日の型」で数えるテイク。デモ投入で作られたテイク(sourceType 'demo')は、
 * 解析は本物と同じでも人が今日弾いたものではないので日集計から外す。
 * お手本(role 'reference')や音符起こしに失敗したテイクも数えない。
 */
export function isHabitTake(t: Take): boolean {
  return t.role === 'normal' && t.sourceType !== 'demo' && !!t.noteEvents
}

/** 今日(ローカル)録った habit テイク。渡された順序を保つ */
export function todaysHabitTakes(takes: Take[], now = Date.now()): Take[] {
  const from = startOfDay(now)
  const to = from + DAY_MS
  return takes.filter((t) => isHabitTake(t) && t.recordedAt >= from && t.recordedAt < to)
}

/**
 * スレッドの「温度」。一覧カードの左端バーの色に使う 4 段階。
 * 0 = 今日〜1 日前、1 = 2〜3 日、2 = 4〜7 日、3 = 8 日以上。
 * 責める表現には使わないこと(色は灰〜青の範囲、赤は使わない)。
 */
export function warmthLevel(lastActivityAt: number, now = Date.now()): 0 | 1 | 2 | 3 {
  const d = daysSince(lastActivityAt, now)
  if (d <= 1) return 0
  if (d <= 3) return 1
  if (d <= 7) return 2
  return 3
}
