import { useThreadTakesAsc } from '../habit/useThreadTakes'
import { FLAT_JITTER_MS } from '../habit/verdict'
import { formatChallengeTarget, judgeChallenge, useNextChallenge } from '../habit/nextChallenge'

type Props = { threadId: string; takeId: string }

/**
 * 予告の結果 1 行(C13)。診断画面の VersusCard 直下に置く。
 * 開いているテイクが予告の判定対象(挑む日の最初の 1 本)のときだけ描く。それ以外は何も出さない。
 */
export default function NextChallengeStatus({ threadId, takeId }: Props) {
  const challenge = useNextChallenge()
  const { takesAsc } = useThreadTakesAsc(threadId)

  if (!challenge || challenge.threadId !== threadId || !takesAsc) return null
  const s = judgeChallenge(challenge, takesAsc)
  if (s.kind === 'none' || s.kind === 'planned' || s.kind === 'due' || s.takeId !== takeId) return null

  const target = formatChallengeTarget(s.c)
  if (s.kind === 'fulfilled') {
    return (
      <div className="challenge-status fulfilled">
        <span className="lbl">予告 {target} →</span>
        <span className="result">{s.valueMs !== undefined ? `達成(${s.valueMs}ms)` : '達成(1 本録れました)'}</span>
        <span className="why">自分で立てた目標に対する結果です。音楽的な正しさではありません。</span>
      </div>
    )
  }
  if (s.kind === 'missed') {
    // 差が横ばいの範囲なら「惜しい」。それ以上は数字だけ(未達は数えず、責めない)
    const word = s.overBy < FLAT_JITTER_MS ? `惜しい(+${s.overBy}ms)` : `今回は ${s.valueMs}ms(+${s.overBy}ms)`
    return (
      <div className="challenge-status missed">
        <span className="lbl">予告 {target} →</span>
        <span className="result">{word}</span>
        <span className="why">自分で立てた目標に対する結果です。未達は数えません。</span>
      </div>
    )
  }
  return (
    <div className="challenge-status missed">
      <span className="lbl">予告 {target} →</span>
      <span className="result">判定なし</span>
      <span className="why">{s.reason}</span>
    </div>
  )
}
