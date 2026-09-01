import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { addSongThroughCompletion } from '../actions'

type Props = {
  threadId: string
  onBack: () => void
}

export default function SongThroughView({ threadId, onBack }: Props) {
  // window.promptはプロジェクタに映すデモでOS標準のダイアログが割り込むため、画面内の入力に置き換えている
  const [entering, setEntering] = useState(false)
  const [durationText, setDurationText] = useState('210')
  const [error, setError] = useState<string | null>(null)

  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId])
  const completions = useLiveQuery(
    () => db.songThroughCompletions.where({ threadId }).reverse().sortBy('at'),
    [threadId],
  )

  async function handleAdd() {
    const durationSec = Number(durationText)
    if (!durationText.trim() || Number.isNaN(durationSec) || durationSec <= 0) {
      setError('所要時間は正の数値で入力してください')
      return
    }
    await addSongThroughCompletion(threadId, durationSec)
    setEntering(false)
    setError(null)
    setDurationText('210')
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
        {!entering ? (
          <div className="stack">
            <button className="primary" onClick={() => setEntering(true)}>
              今回も通しで弾いた ＋
            </button>
          </div>
        ) : (
          <div className="inline-form">
            <input
              type="number"
              inputMode="numeric"
              value={durationText}
              autoFocus
              placeholder="所要時間(秒)"
              onChange={(e) => setDurationText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd()
                if (e.key === 'Escape') setEntering(false)
              }}
            />
            <div className="btn-row">
              <button className="primary" onClick={handleAdd}>
                記録する
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setEntering(false)
                  setError(null)
                }}
              >
                やめる
              </button>
            </div>
          </div>
        )}
        {error && <div className="notice error">{error}</div>}

        <div className="section-title">完走ログ</div>
        {(completions ?? []).map((c) => (
          <div className="card" style={{ cursor: 'default' }} key={c.id}>
            <div className="row">
              <div className="title">{new Date(c.at).toLocaleString('ja-JP')}</div>
              <div className="meta">{(c.durationMs / 1000).toFixed(0)}秒</div>
            </div>
          </div>
        ))}
        {(completions ?? []).length === 0 && (
          <div className="note-block">まだ完走ログがありません。</div>
        )}
        <div className="note-block">
          曲通しスレッドは診断を行わず、完走回数・所要時間の簡易記録のみです(PRD Non-goal準拠)。
        </div>
      </div>
    </>
  )
}
