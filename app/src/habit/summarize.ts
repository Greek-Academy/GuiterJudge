import type { Thread, Take, DiagnosisResult } from '../db'
import { todaysHabitTakes } from './dailyStats'
import { judgeAgainstPrev, jitterValueOf, withPrevDiags, FLAT_JITTER_MS } from './verdict'

// 「今日のまとめ」(C11)の材料を作る純関数。React にも Dexie にも依存しない。
//
// 出すのは「今日録った事実」と「直前比の勝敗の内訳」だけ。連続日数は出さない
// (途切れたときに全損感を作らないため)。「上達した」とは書かず、数値と方向だけを書く。
// 引き分け(横ばい)の判定は verdict.ts の定数に従い、ここに別のしきい値を置かない。

export type DaySummary = {
  /** 今日の habit テイク数(デモ・お手本を除く) */
  takeCount: number
  /** 今日録ったスレッド数 */
  threadCount: number
  /** 今日の各テイクの「出だしのばらつき」の直前比判定。na = 比べられなかった(初テイク・音数不足など) */
  tally: { win: number; draw: number; loss: number; na: number }
  /** 今日 2 本以上録ったスレッドの「最初 → 最後」。最大 3 本、最後に録った順 */
  lines: { threadId: string; title: string; text: string }[]
  /** 今日最後に録ったテイク。「明日もこのフレーズで」の既定にする */
  last: { threadId: string; title: string; take: Take }
}

/** 「31 → 22ms」/「横ばい(28 → 26ms)」。差が FLAT_JITTER_MS 未満は横ばいと言い切る(ScoreTrend と同じ態度) */
export function formatDelta(firstMs: number, lastMs: number): string {
  const a = Math.round(firstMs)
  const b = Math.round(lastMs)
  if (Math.abs(lastMs - firstMs) < FLAT_JITTER_MS) return `横ばい(${a} → ${b}ms)`
  return `${a} → ${b}ms`
}

export function summarizeToday(args: {
  threads: Thread[]
  /** recordedAt 昇順。role は混在してよい */
  takesAsc: Take[]
  /** takeId → compareMode 'prev' の保存済み診断。保存が無いテイクは verdict.withPrevDiags がその場で埋める */
  prevDiagByTake: Map<string, DiagnosisResult>
  now?: number
}): DaySummary | null {
  const { threads, takesAsc } = args
  const prevDiagByTake = withPrevDiags(takesAsc, args.prevDiagByTake)
  const now = args.now ?? Date.now()
  const today = todaysHabitTakes(takesAsc, now)
  if (today.length === 0) return null

  const titleOf = new Map(threads.map((t) => [t.id, t.title]))
  const title = (threadId: string) => titleOf.get(threadId) ?? '(不明なスレッド)'

  // 直前比の判定。比較相手はスレッド内の直前の normal テイク(デモも含む。同じ解析経路を通っているので比べられる)
  const tally = { win: 0, draw: 0, loss: 0, na: 0 }
  for (const cur of today) {
    let prev: Take | undefined
    for (const t of takesAsc) {
      if (t.threadId !== cur.threadId || t.role !== 'normal' || !t.noteEvents) continue
      if (t.recordedAt >= cur.recordedAt) break
      prev = t
    }
    const v = judgeAgainstPrev({
      cur,
      prev,
      curDiag: prevDiagByTake.get(cur.id),
      prevDiag: prev ? prevDiagByTake.get(prev.id) : undefined,
    })
    const jitter = v.eligible ? v.items.find((i) => i.key === 'jitter') : undefined
    if (!jitter) tally.na++
    else tally[jitter.outcome]++
  }

  // スレッドごとの今日のテイク(昇順)
  const byThread = new Map<string, Take[]>()
  for (const t of today) {
    const arr = byThread.get(t.threadId)
    if (arr) arr.push(t)
    else byThread.set(t.threadId, [t])
  }

  const lines = [...byThread.entries()]
    .filter(([, ts]) => ts.length >= 2)
    // 最後に録ったスレッドを先頭に(いま練習を終えたところが一番上に来る)
    .sort((a, b) => b[1][b[1].length - 1].recordedAt - a[1][a[1].length - 1].recordedAt)
    .slice(0, 3)
    .map(([threadId, ts]) => {
      // ばらつきの取り方(格子 / 直前比)は verdict.ts に合わせる。音数不足のテイクは null になる
      const first = jitterValueOf(ts[0], prevDiagByTake)
      const last = jitterValueOf(ts[ts.length - 1], prevDiagByTake)
      const count = `${ts.length} テイク`
      let text: string
      if (first && last && first.basis === last.basis) {
        text = `${count} · ${formatDelta(first.value, last.value)}${first.basis === 'relative' ? '(直前比)' : ''}`
      } else {
        // 片方だけメトロノーム有り、または比較結果が無い → 数字を並べると別物を比べることになるので本数だけ
        text = count
      }
      return { threadId, title: title(threadId), text }
    })

  const lastTake = today[today.length - 1]
  return {
    takeCount: today.length,
    threadCount: byThread.size,
    tally,
    lines,
    last: { threadId: lastTake.threadId, title: title(lastTake.threadId), take: lastTake },
  }
}
