import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { addSongThroughCompletion } from '../actions'

type Props = {
  threadId: string
  onBack: () => void
}

export default function SongThroughView({ threadId, onBack }: Props) {
  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId])
  const completions = useLiveQuery(
    () => db.songThroughCompletions.where({ threadId }).reverse().sortBy('at'),
    [threadId],
  )

  async function handleAdd() {
    const input = window.prompt('所要時間(秒)を入力してください', '210')
    if (!input) return
    const durationSec = Number(input)
    if (Number.isNaN(durationSec)) return
    await addSongThroughCompletion(threadId, durationSec)
  }

  if (!thread) return null

  return (
    <>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>
          ← 戻る
        </button>
        <h1>{thread.title}</h1>
      </div>
      <div style={{ overflowY: 'auto' }}>
        <div className="stack">
          <button className="primary" onClick={handleAdd}>
            今回も通しで弾いた ＋
          </button>
        </div>
        <div className="section-title">完走ログ</div>
        {(completions ?? []).map((c) => (
          <div className="card" style={{ cursor: 'default' }} key={c.id}>
            <div className="row">
              <div className="title">{new Date(c.at).toLocaleString('ja-JP')}</div>
              <div className="meta">{(c.durationMs / 1000).toFixed(0)}秒</div>
            </div>
          </div>
        ))}
        <div className="note-block">
          曲通しスレッドは診断を行わず、完走回数・所要時間の簡易記録のみです(PRD Non-goal準拠)。
        </div>
      </div>
    </>
  )
}
