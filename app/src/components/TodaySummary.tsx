import { useMemo } from 'react'
import type { GridTiming } from '../gridTiming'
import { dayKey } from '../habit/dailyStats'
import { useAllHabitData } from '../habit/useThreadTakes'
import { summarizeToday } from '../habit/summarize'
import { dismissSummary, useSummaryDismissed } from '../habit/summaryDismiss'
import { FLAT_JITTER_MS } from '../habit/verdict'
import {
  clearNextChallenge,
  draftChallengeFromTake,
  formatChallengeTarget,
  judgeChallenge,
  setNextChallenge,
  useNextChallenge,
} from '../habit/nextChallenge'

type Props = {
  /** 予告のスレッドを今すぐ録る(autoRecord 遷移。WP-D が App.tsx で配線) */
  onRecordNow: (threadId: string) => void
}

/**
 * 今日のまとめ(C11)。今日 1 本以上(デモ除く)録った日に、ホーム最上部に 1 枚出す。
 * 「今日はここまで」で当日中は畳む。翌日には再び出る(summaryDismiss.ts)。
 * 連続日数は出さない。「上達」とは書かず、本数と直前比の内訳と数値の変化だけを書く。
 */
export default function TodaySummary({ onRecordNow }: Props) {
  const { threads, takesAsc, prevDiagByTake } = useAllHabitData()
  const today = dayKey(Date.now())
  const dismissed = useSummaryDismissed(today)
  const challenge = useNextChallenge()

  const summary = useMemo(
    () => (threads && takesAsc && prevDiagByTake ? summarizeToday({ threads, takesAsc, prevDiagByTake }) : null),
    [threads, takesAsc, prevDiagByTake],
  )

  if (!summary || dismissed) return null

  const status = judgeChallenge(challenge, takesAsc ?? [])
  const challengeThread = status.kind === 'none' ? undefined : threads?.find((t) => t.id === status.c.threadId)
  const judged = tallyLine(summary.tally)

  /** 「明日もこのフレーズで」= 今日最後に録ったテイクから予告を作る(既存の予告は上書き) */
  function planFromLast() {
    setNextChallenge(draftChallengeFromTake(summary!.last.take))
  }

  return (
    <div className="today-summary">
      <div className="kicker">今日のまとめ</div>
      <div className="facts">
        {summary.takeCount}
        <span className="unit">テイク</span>/ {summary.threadCount}
        <span className="unit">スレッド</span>
      </div>
      {judged && <div className="tally">{judged}</div>}
      {summary.lines.map((l) => (
        <div className="delta-line" key={l.threadId}>
          <span className="t">{l.title}:</span>
          <span className="d">{l.text}</span>
        </div>
      ))}

      {/* 予告の状態。常に 1 件なので、この行も 1 行だけ */}
      <div className="challenge-row">
        {status.kind === 'planned' && challengeThread ? (
          <>
            <span className="lbl">明日の予告:</span>
            <span>
              {challengeThread.title} · {formatChallengeTarget(status.c)}
            </span>
            <button className="link" onClick={clearNextChallenge}>
              取り消す
            </button>
          </>
        ) : status.kind === 'due' && challengeThread ? (
          <>
            <span className="lbl">予告:</span>
            <span>
              {challengeThread.title} · {formatChallengeTarget(status.c)}(まだ今日は録っていません)
            </span>
            <button className="secondary" onClick={() => onRecordNow(status.c.threadId)}>
              ● 録る
            </button>
          </>
        ) : (
          <>
            {(status.kind === 'fulfilled' || status.kind === 'missed' || status.kind === 'unjudged') && challengeThread && (
              <span className="lbl">
                予告 {formatChallengeTarget(status.c)} → {resultWord(status)}
              </span>
            )}
            <button className="secondary" onClick={planFromLast}>
              明日もこのフレーズで({summary.last.title}
              {targetSuffix(summary.last.take.gridTiming)})
            </button>
          </>
        )}
      </div>

      <div className="why">同じように弾けているか(一貫性)の集計です。音楽的な正しさではありません。</div>
      <div className="close">
        <button className="secondary" onClick={() => dismissSummary(today)}>
          今日はここまで
        </button>
      </div>
    </div>
  )
}

/** 「前回より安定 2 · 横ばい 1 · ばらつき増 1」。比べられなかったテイク(na)は数えない。全部 na なら出さない */
function tallyLine(t: { win: number; draw: number; loss: number }): string | null {
  if (t.win + t.draw + t.loss === 0) return null
  return `前回より安定 ${t.win} · 横ばい ${t.draw} · ばらつき増 ${t.loss}`
}

function resultWord(s: ReturnType<typeof judgeChallenge>): string {
  switch (s.kind) {
    case 'fulfilled':
      return s.valueMs !== undefined ? `達成(${s.valueMs}ms)` : '達成'
    case 'missed':
      // 診断画面の NextChallengeStatus と同じ言い方にそろえる(横ばいの範囲なら「惜しい」、それ以上は数字だけ)
      return s.overBy < FLAT_JITTER_MS ? `惜しい(+${s.overBy}ms)` : `${s.valueMs}ms(+${s.overBy}ms)`
    case 'unjudged':
      return '判定なし'
    default:
      return ''
  }
}

/** ボタン内の「 · 19ms 以内」。draftChallengeFromTake と同じ条件で ms を出す */
function targetSuffix(grid: GridTiming | null | undefined): string {
  const d = draftChallengeFromTake({ threadId: '', gridTiming: grid })
  return d.targetJitterMs !== undefined ? ` · ${d.targetJitterMs}ms 以内` : ''
}
