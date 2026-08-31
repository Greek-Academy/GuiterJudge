import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { startRecording, stopRecordingAndDiagnose, setReferenceTakeFromFile, resolveThread } from '../actions'
import { playNoteEvents } from '../preview'

type Props = {
  threadId: string
  onBack: () => void
  onOpenDiagnosis: (takeId: string) => void
}

export default function ThreadDetail({ threadId, onBack, onOpenDiagnosis }: Props) {
  const [isRecording, setIsRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showSelfCheck, setShowSelfCheck] = useState(false)

  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId])
  const takes = useLiveQuery(
    () => db.takes.where({ threadId, role: 'normal' }).reverse().sortBy('recordedAt'),
    [threadId],
  )
  const referenceTake = useLiveQuery(() => db.takes.where({ threadId, role: 'reference' }).first(), [threadId])
  const diagnosisByTake = useLiveQuery(async () => {
    const results = await db.diagnosisResults.toArray()
    const map = new Map<string, (typeof results)[number]>()
    for (const r of results) map.set(r.takeId, r)
    return map
  }, [])

  async function handleRecordToggle() {
    if (!isRecording) {
      setBusy(true)
      try {
        await startRecording()
        setIsRecording(true)
      } catch (e) {
        alert('マイクの利用許可が必要です: ' + (e as Error).message)
      } finally {
        setBusy(false)
      }
    } else {
      setIsRecording(false)
      setBusy(true)
      try {
        const { takeId } = await stopRecordingAndDiagnose(threadId)
        onOpenDiagnosis(takeId)
      } catch (e) {
        alert('録音・音符起こしに失敗しました: ' + (e as Error).message)
      } finally {
        setBusy(false)
      }
    }
  }

  async function handleReferenceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      await setReferenceTakeFromFile(threadId, file)
    } catch (err) {
      alert('お手本の取り込みに失敗しました: ' + (err as Error).message)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  async function handleResolve(selfCheck: 'yes' | 'no' | 'unsure') {
    const lastTake = takes?.[0]
    const lastDiagnosis = lastTake ? diagnosisByTake?.get(lastTake.id) : undefined
    await resolveThread(threadId, lastDiagnosis?.id, selfCheck)
    setShowSelfCheck(false)
    onBack()
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
          <button className="primary" onClick={handleRecordToggle} disabled={busy}>
            {busy ? '処理中...' : isRecording ? '■ 録音停止' : '● 録音する'}
          </button>

          <label className="secondary" style={{ display: 'block', textAlign: 'center' }}>
            {referenceTake ? 'お手本を差し替える' : 'お手本を設定する(音声/動画ファイル)'}
            <input type="file" accept="audio/*,video/*" style={{ display: 'none' }} onChange={handleReferenceFile} />
          </label>
          {referenceTake && (
            <div className="meta row" style={{ justifyContent: 'space-between' }}>
              <span>お手本設定済み ({referenceTake.sourceType})</span>
              {referenceTake.noteEvents && (
                <button className="secondary" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => playNoteEvents(referenceTake.noteEvents!)}>
                  ▶ プレビュー再生
                </button>
              )}
            </div>
          )}
        </div>

        <div className="section-title">テイク履歴</div>
        {(takes ?? []).map((t) => {
          const d = diagnosisByTake?.get(t.id)
          return (
            <div className="card" key={t.id} onClick={() => onOpenDiagnosis(t.id)}>
              <div className="row">
                <div className="title">{new Date(t.recordedAt).toLocaleString('ja-JP')}</div>
                {d && <span className="badge">安定度 {d.stabilityScore}</span>}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <div className="meta" style={{ flex: 1, marginTop: 0 }}>
                  長さ {(t.durationMs / 1000).toFixed(1)}秒
                  {t.noteEvents ? ` / 音符${t.noteEvents.length}個検出` : ' / 音符起こし失敗'}
                </div>
                {t.noteEvents && (
                  <button
                    className="secondary"
                    style={{ width: 'auto', padding: '4px 10px' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      playNoteEvents(t.noteEvents!)
                    }}
                  >
                    ▶ 採譜プレビュー
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {!showSelfCheck ? (
          <button className="secondary" style={{ margin: '14px 16px', width: 'calc(100% - 32px)' }} onClick={() => setShowSelfCheck(true)}>
            ✓ このスレッドを解決済みにする
          </button>
        ) : (
          <div className="self-check">
            <div className="q">この演奏、実際に合っていると感じますか？</div>
            <div className="btn-row">
              <button onClick={() => handleResolve('yes')}>はい</button>
              <button onClick={() => handleResolve('no')}>いいえ</button>
              <button onClick={() => handleResolve('unsure')}>わからない</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
