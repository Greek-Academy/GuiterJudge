import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import {
  startRecording,
  stopRecordingAndDiagnose,
  setReferenceTakeFromFile,
  setReferenceTakeFromExistingTake,
  clearReferenceTake,
  resolveThread,
} from '../actions'
import { playNoteEvents } from '../preview'
import ScoreTrend, { type ScoreTrendPoint } from '../components/ScoreTrend'

type Props = {
  threadId: string
  onBack: () => void
  onOpenDiagnosis: (takeId: string) => void
}

type Notice = { kind: 'success' | 'error'; text: string }

export default function ThreadDetail({ threadId, onBack, onOpenDiagnosis }: Props) {
  const [isRecording, setIsRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showSelfCheck, setShowSelfCheck] = useState(false)
  // alert()はプロジェクタに映すデモでOS標準ダイアログが割り込むため、画面内の通知に置き換えている
  const [notice, setNotice] = useState<Notice | null>(null)

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

  // スコア推移。takesはrecordedAtの降順なので、グラフ用に昇順へ戻したうえで
  // 診断結果があるテイクだけを拾う(各スレッドの最初のテイクは比較対象が無く診断が無い)
  const trend = useMemo(() => {
    const ascending = [...(takes ?? [])].reverse()
    const points: ScoreTrendPoint[] = []
    const takeIds: string[] = []
    for (const t of ascending) {
      const d = diagnosisByTake?.get(t.id)
      if (!d) continue
      points.push({ at: t.recordedAt, score: d.stabilityScore, label: `${(t.durationMs / 1000).toFixed(1)}秒` })
      takeIds.push(t.id)
    }
    return { points, takeIds }
  }, [takes, diagnosisByTake])

  async function handleRecordToggle() {
    setNotice(null)
    if (!isRecording) {
      setBusy(true)
      try {
        await startRecording()
        setIsRecording(true)
      } catch (e) {
        setNotice({ kind: 'error', text: 'マイクの利用許可が必要です: ' + (e as Error).message })
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
        setNotice({ kind: 'error', text: '録音・音符起こしに失敗しました: ' + (e as Error).message })
      } finally {
        setBusy(false)
      }
    }
  }

  async function handleReferenceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setNotice(null)
    try {
      await setReferenceTakeFromFile(threadId, file)
      setNotice({ kind: 'success', text: 'お手本を設定しました' })
    } catch (err) {
      setNotice({ kind: 'error', text: 'お手本の取り込みに失敗しました: ' + (err as Error).message })
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  async function handlePromoteToReference(takeId: string) {
    setNotice(null)
    try {
      await setReferenceTakeFromExistingTake(threadId, takeId)
      setNotice({ kind: 'success', text: 'このテイクをお手本にしました' })
    } catch (err) {
      setNotice({ kind: 'error', text: 'お手本に設定できませんでした: ' + (err as Error).message })
    }
  }

  async function handleClearReference() {
    await clearReferenceTake(threadId)
    setNotice({ kind: 'success', text: 'お手本の指定を解除しました' })
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
        {thread.status === 'resolved' && <span className="badge">解決済み</span>}
      </div>
      <div style={{ overflowY: 'auto' }}>
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

        <div className="stack">
          <button className="primary" onClick={handleRecordToggle} disabled={busy}>
            {busy ? '処理中...' : isRecording ? '■ 録音停止' : '● 録音する'}
          </button>
        </div>

        {/* PRD Goal #1「どこが伸びていてどこが停滞しているか」に直接対応する画面。
            テイクの一覧だけでは、数字が並んでいても推移が読み取れなかった */}
        {trend.points.length > 0 && (
          <div className="chart-block">
            <ScoreTrend points={trend.points} onSelect={(i) => onOpenDiagnosis(trend.takeIds[i])} />
          </div>
        )}

        <div className="section-title">お手本(任意)</div>
        {referenceTake ? (
          <>
            <div className="card" style={{ cursor: 'default' }}>
              <div className="row">
                <div className="title">
                  お手本 ({referenceTake.sourceType === 'demo' ? 'デモ音源' : referenceTake.sourceType})
                </div>
                {referenceTake.noteEvents && (
                  <button
                    className="secondary"
                    style={{ width: 'auto', padding: '4px 10px' }}
                    onClick={() => playNoteEvents(referenceTake.noteEvents!)}
                  >
                    ▶ プレビュー
                  </button>
                )}
              </div>
              <div className="meta">
                {new Date(referenceTake.recordedAt).toLocaleString('ja-JP')} / 長さ{' '}
                {(referenceTake.durationMs / 1000).toFixed(1)}秒
              </div>
            </div>
            <div className="stack">
              <label className="secondary" style={{ display: 'block', textAlign: 'center' }}>
                お手本を差し替える(音声/動画ファイル)
                <input
                  type="file"
                  accept="audio/*,video/*"
                  style={{ display: 'none' }}
                  onChange={handleReferenceFile}
                  disabled={busy}
                />
              </label>
              <button className="secondary danger" onClick={handleClearReference}>
                お手本の指定を解除する
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="note-block">
              自己比較は「毎回同じように弾けているか」しか測れないため、最初から間違えている場合は
              気づけません。お手本を設定すると「正しさ」に近い比較ができます。
              講師などの録音を取り込むか、下のテイク履歴から自分のうまく弾けたテイクを選べます。
            </div>
            <div className="stack">
              <label className="secondary" style={{ display: 'block', textAlign: 'center' }}>
                お手本を設定する(音声/動画ファイル)
                <input
                  type="file"
                  accept="audio/*,video/*"
                  style={{ display: 'none' }}
                  onChange={handleReferenceFile}
                  disabled={busy}
                />
              </label>
            </div>
          </>
        )}

        <div className="section-title">テイク履歴</div>
        {(takes ?? []).length === 0 && (
          <div className="note-block">
            まだテイクがありません。1回目は比較対象が無いため診断は出ず、2回目から比較が始まります。
          </div>
        )}
        {(takes ?? []).map((t) => {
          const d = diagnosisByTake?.get(t.id)
          return (
            <div className="card" key={t.id} onClick={() => onOpenDiagnosis(t.id)}>
              <div className="row">
                <div className="title">{new Date(t.recordedAt).toLocaleString('ja-JP')}</div>
                {t.sourceType === 'demo' && <span className="badge">デモ</span>}
                {d && <span className="badge">安定度 {d.stabilityScore}</span>}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <div className="meta" style={{ flex: 1, marginTop: 0 }}>
                  長さ {(t.durationMs / 1000).toFixed(1)}秒
                  {t.noteEvents ? ` / 音符${t.noteEvents.length}個検出` : ' / 音符起こし失敗'}
                </div>
                {t.noteEvents && (
                  <>
                    <button
                      className="secondary"
                      style={{ width: 'auto', padding: '4px 10px' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        playNoteEvents(t.noteEvents!)
                      }}
                    >
                      ▶ 採譜
                    </button>
                    <button
                      className="secondary"
                      style={{ width: 'auto', padding: '4px 10px' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        void handlePromoteToReference(t.id)
                      }}
                    >
                      お手本にする
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}

        {thread.status === 'active' &&
          (!showSelfCheck ? (
            <button
              className="secondary"
              style={{ margin: '14px 16px', width: 'calc(100% - 32px)' }}
              onClick={() => setShowSelfCheck(true)}
            >
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
          ))}
      </div>
    </>
  )
}
