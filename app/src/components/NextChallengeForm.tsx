import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { dayKey } from '../habit/dailyStats'
import {
  CHALLENGE_TTL_DAYS,
  clearNextChallenge,
  draftChallengeFromTake,
  formatChallengeTarget,
  setNextChallenge,
  useNextChallenge,
} from '../habit/nextChallenge'

type Props = { threadId: string; takeId: string }

/**
 * 明日の予告(C13)。診断画面のスクロール領域の最後に置く。
 * 今回のテイクにメトロノーム録音の値があれば「明日はこのフレーズで 19ms 以内(♩=80)を狙う」、
 * 無ければ「明日もこのフレーズを 1 本」。押すと 1 件だけ保存され、翌日の「今日の一本」候補になる。
 */
export default function NextChallengeForm({ threadId, takeId }: Props) {
  const take = useLiveQuery(() => db.takes.get(takeId), [takeId])
  const challenge = useNextChallenge()
  // 別スレッドの予告があるときは、上書きされることを文言で伝えたいのでタイトルを取る
  const otherThread = useLiveQuery(
    () => (challenge && challenge.threadId !== threadId ? db.threads.get(challenge.threadId) : undefined),
    [challenge?.threadId, threadId],
  )

  if (!take) return null

  const now = Date.now()
  // 「予告済み」= このスレッドの予告を今日作った。昨日作った予告(今日が挑む日)はここでは既定表示に戻し、
  // 結果は NextChallengeStatus が出す
  const setToday = challenge !== null && challenge.threadId === threadId && dayKey(challenge.madeAt) === dayKey(now)

  if (setToday) {
    return (
      <div className="next-challenge set">
        <div className="kicker">明日の予告</div>
        <div className="lead">
          予告しました。明日の一本になります(<span className="target">{formatChallengeTarget(challenge)}</span>)。
        </div>
        <div className="actions">
          <button className="link" onClick={clearNextChallenge}>
            取り消す
          </button>
        </div>
        <div className="fine">予告は 1 件だけ。{CHALLENGE_TTL_DAYS} 日たつと静かに消えます。</div>
      </div>
    )
  }

  const draft = draftChallengeFromTake(take, now)
  return (
    <div className="next-challenge">
      <div className="kicker">明日の予告</div>
      <div className="lead">
        {draft.targetJitterMs !== undefined ? (
          <>
            明日はこのフレーズで <span className="target">{draft.targetJitterMs}ms 以内</span>(♩={draft.bpm})を狙う
          </>
        ) : (
          <>明日もこのフレーズを 1 本</>
        )}
      </div>
      <div className="actions">
        <button className="primary" onClick={() => setNextChallenge({ ...draft, madeAt: Date.now() })}>
          予告する
        </button>
        {otherThread && <span className="fine" style={{ margin: 0 }}>いまの予告(「{otherThread.title}」)と入れ替わります</span>}
      </div>
      <div className="fine">
        予告は 1 件だけ。{CHALLENGE_TTL_DAYS} 日たつと静かに消えます。
        {draft.targetJitterMs !== undefined && ' 目標は今回と同じ ms 以内(同じように弾けるか)で、テンポを落とした回は達成に数えません。'}
      </div>
    </div>
  )
}
