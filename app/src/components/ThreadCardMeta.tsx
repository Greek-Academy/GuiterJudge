import type { Thread } from '../db'
import { daysSince } from '../habit/dailyStats'
import { daysAgoLabel } from '../habit/pickToday'

// 一覧カードの meta 行(C08「スレッドの冷え」を吸収)。
// 「最終更新: 2026/9/20 21:10:33」の代わりに「3 日前 · 12 テイク · ♩=80」と読めるようにする。
// 日数が増えても文言は中立のまま(「9 日前」)で、赤や警告アイコンは使わない。
// 冷えは .card の左端 3px バーの色だけで表す(habit/pickToday.ts の warmthClass() が 4 段階のクラス名を返す)。

type Props = {
  thread: Thread
  /** このスレッドの normal テイク数(統合側が takes から数える) */
  takeCount: number
  /** 「ばらつき 42ms」など。渡せば末尾に足す(既存の .badge と重複させたくなければ渡さない) */
  lastJitterLabel?: string
  now?: number
}

export default function ThreadCardMeta({ thread, takeCount, lastJitterLabel, now = Date.now() }: Props) {
  const parts: string[] = [daysAgoLabel(daysSince(thread.lastActivityAt, now)), `${takeCount} テイク`]
  if (thread.metronome) parts.push(`♩=${thread.metronome.bpm}`)
  if (lastJitterLabel) parts.push(lastJitterLabel)
  return (
    <div className="meta thread-meta" title={`最終更新: ${new Date(thread.lastActivityAt).toLocaleString('ja-JP')}`}>
      {parts.join(' · ')}
    </div>
  )
}
