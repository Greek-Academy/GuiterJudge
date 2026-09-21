import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db, { type MetronomeSpec } from '../db'
import {
  startRecording,
  stopRecordingAndDiagnose,
  setReferenceTakeFromFile,
  setReferenceTakeFromExistingTake,
  clearReferenceTake,
  resolveThread,
  setThreadMetronome,
  setThreadChordMode,
} from '../actions'
import { playNoteEvents } from '../preview'
import { formatProgression } from '../chordRecognition'
import type { BeatInfo } from '../metronome'
import type { Subdivision } from '../gridTiming'
import ScoreTrend, { type ScoreTrendPoint } from '../components/ScoreTrend'
import { JITTER_METRIC, RELATIVE_JITTER_METRIC } from '../components/trendMetrics'

/** 初めてメトロノームをONにしたときの既定値。16分を既定にしているのは、粗い格子で細かい演奏を測ると
 *  半数の音が格子の中間に落ちて解析が破綻するため(細かい格子で粗い演奏を測るのは問題ない) */
const DEFAULT_METRONOME: MetronomeSpec = { bpm: 80, subdivision: 4, countInBeats: 4, beatsPerBar: 4 }
const SUBDIVISIONS: { value: Subdivision; label: string }[] = [
  { value: 1, label: '4分' },
  { value: 2, label: '8分' },
  { value: 3, label: '3連' },
  { value: 4, label: '16分' },
]

type Props = {
  threadId: string
  onBack: () => void
  onOpenDiagnosis: (takeId: string) => void
}

type Notice = { kind: 'success' | 'error'; text: string }

export default function ThreadDetail({ threadId, onBack, onOpenDiagnosis }: Props) {
  const [isRecording, setIsRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  /** null = メトロノームなしで録る */
  const [metro, setMetro] = useState<MetronomeSpec | null>(null)
  const [metroLoaded, setMetroLoaded] = useState(false)
  /** 録音中の拍。カウントイン中は残り拍数を大きく出す */
  const [beat, setBeat] = useState<BeatInfo | null>(null)
  const [showSelfCheck, setShowSelfCheck] = useState(false)
  // alert()はプロジェクタに映すデモでOS標準ダイアログが割り込むため、画面内の通知に置き換えている
  const [notice, setNotice] = useState<Notice | null>(null)

  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId])
  // スレッドに保存してある前回のメトロノーム設定を、初回だけ初期値として取り込む
  useEffect(() => {
    if (thread && !metroLoaded) {
      setMetro(thread.metronome ?? null)
      setMetroLoaded(true)
    }
  }, [thread, metroLoaded])
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

  // ばらつきの推移。takesはrecordedAtの降順なので、グラフ用に昇順へ戻す。
  // メトロノーム録音(拍に対する絶対ばらつき)があればそれを描く。比較対象が要らないので
  // 1本目のテイクから点が付き、日をまたいでも同じ物差しで並ぶ。
  // 無ければ直前比較の相対ばらつきで代用する(各スレッドの最初のテイクは比較対象が無く点が無い)。
  const trend = useMemo(() => {
    const ascending = [...(takes ?? [])].reverse()
    const gridPoints: ScoreTrendPoint[] = []
    const gridTakeIds: string[] = []
    for (const t of ascending) {
      if (!t.gridTiming) continue
      gridPoints.push({ at: t.recordedAt, value: t.gridTiming.jitterMs, label: `♩=${t.gridTiming.bpm} / ${t.gridTiming.onsetCount}音` })
      gridTakeIds.push(t.id)
    }
    if (gridPoints.length > 0) return { points: gridPoints, takeIds: gridTakeIds, metric: JITTER_METRIC }

    const points: ScoreTrendPoint[] = []
    const takeIds: string[] = []
    for (const t of ascending) {
      const d = diagnosisByTake?.get(t.id)
      if (!d) continue
      points.push({ at: t.recordedAt, value: d.timingJitterMs, label: `${(t.durationMs / 1000).toFixed(1)}秒` })
      takeIds.push(t.id)
    }
    return { points, takeIds, metric: RELATIVE_JITTER_METRIC }
  }, [takes, diagnosisByTake])

  async function handleChordModeToggle(on: boolean) {
    setNotice(null)
    setBusy(true)
    try {
      // ONにすると、和音認識の結果が無い過去テイクを保存音声から埋める(数十ms/テイク)
      await setThreadChordMode(threadId, on)
    } catch (e) {
      setNotice({ kind: 'error', text: '和音認識に失敗しました: ' + (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  function updateMetro(patch: Partial<MetronomeSpec>) {
    const next = { ...(metro ?? DEFAULT_METRONOME), ...patch }
    setMetro(next)
    void setThreadMetronome(threadId, next)
  }

  async function handleRecordToggle() {
    setNotice(null)
    if (!isRecording) {
      setBusy(true)
      try {
        await startRecording(metro, setBeat)
        setIsRecording(true)
      } catch (e) {
        setNotice({ kind: 'error', text: 'マイクの利用許可が必要です: ' + (e as Error).message })
      } finally {
        setBusy(false)
      }
    } else {
      setIsRecording(false)
      setBeat(null)
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

        {/* メトロノーム。BPMが既知なら拍の格子に対するばらつきを1テイク単体で測れる
            (直前のテイクという動く基準に頼らない)。録音中は設定を触れないようにする */}
        {!isRecording && (
          <>
            <div className="metro-panel">
              <label className="row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={thread.chordMode === true}
                  disabled={busy}
                  onChange={(e) => void handleChordModeToggle(e.target.checked)}
                />
                <span style={{ flex: 1 }}>和音(ストローク)の練習</span>
              </label>
              {thread.chordMode && (
                <div className="note-block" style={{ margin: 0 }}>
                  コード進行(フーリエ変換 → 12音 → コードのテンプレート照合)を認識して、テイク間で比べます。
                  ストロークは音符起こしが安定しないので、音符単位の指標は目安になります。
                </div>
              )}
            </div>
            <div className="metro-panel">
              <label className="row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={metro !== null}
                  onChange={(e) => {
                    if (e.target.checked) updateMetro({})
                    else {
                      setMetro(null)
                      void setThreadMetronome(threadId, null)
                    }
                  }}
                />
                <span style={{ flex: 1 }}>メトロノームに合わせて録る</span>
              </label>
              {metro ? (
                <>
                  <div className="row metro-row">
                    <span className="lbl">♩=</span>
                    <button className="stepper" onClick={() => updateMetro({ bpm: Math.max(40, metro.bpm - 5) })}>
                      −
                    </button>
                    <input
                      type="number"
                      min={40}
                      max={240}
                      value={metro.bpm}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (Number.isFinite(v) && v >= 40 && v <= 240) updateMetro({ bpm: Math.round(v) })
                      }}
                    />
                    <button className="stepper" onClick={() => updateMetro({ bpm: Math.min(240, metro.bpm + 5) })}>
                      ＋
                    </button>
                  </div>
                  <div className="row metro-row">
                    <span className="lbl">最小音価</span>
                    <div className="pill-row" style={{ margin: 0, flex: 1 }}>
                      {SUBDIVISIONS.map((s) => (
                        <div
                          key={s.value}
                          className={`pill ${metro.subdivision === s.value ? 'active' : ''}`}
                          onClick={() => updateMetro({ subdivision: s.value })}
                        >
                          {s.label}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="row metro-row">
                    <span className="lbl">カウントイン</span>
                    <div className="pill-row" style={{ margin: 0, flex: 1 }}>
                      {[0, 2, 4, 8].map((n) => (
                        <div
                          key={n}
                          className={`pill ${metro.countInBeats === n ? 'active' : ''}`}
                          onClick={() => updateMetro({ countInBeats: n })}
                        >
                          {n === 0 ? 'なし' : `${n}拍`}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="meta" style={{ margin: 0 }}>
                    クリックは5kHz付近の音なので、スピーカーで鳴らしてマイクに入っても採譜には乗りません。
                    最小音価は演奏に含まれる一番細かい音符に合わせてください(粗いと解析が破綻します)。
                  </div>
                </>
              ) : (
                <div className="meta" style={{ margin: 0 }}>
                  メトロノームなしでも録れますが、その場合の安定度は「直前のテイクとの差」でしか測れません。
                </div>
              )}
            </div>
          </>
        )}

        <div className="stack">
          <button className="primary" onClick={handleRecordToggle} disabled={busy}>
            {busy ? '処理中...' : isRecording ? '■ 録音停止' : '● 録音する'}
          </button>
        </div>

        {/* カウントイン → 演奏中の拍表示。音だけだと「もう弾いていいのか」が分かりにくい */}
        {isRecording && metro && (
          <div className="count-in" aria-live="polite">
            {beat === null ? (
              <div className="num">…</div>
            ) : beat.countInRemaining !== null ? (
              <>
                <div className="num">{beat.countInRemaining}</div>
                <div className="sub">カウントイン。次の1拍目から弾き始めてください</div>
              </>
            ) : (
              <>
                <div className={`num ${beat.beatInBar === 0 ? 'accent' : ''}`}>{(beat.beatInBar ?? 0) + 1}</div>
                <div className="sub">♩={metro.bpm} 録音中</div>
              </>
            )}
          </div>
        )}

        {/* PRD Goal #1「どこが伸びていてどこが停滞しているか」に直接対応する画面。
            テイクの一覧だけでは、数字が並んでいても推移が読み取れなかった */}
        {trend.points.length > 0 && (
          <div className="chart-block">
            <ScoreTrend points={trend.points} metric={trend.metric} onSelect={(i) => onOpenDiagnosis(trend.takeIds[i])} />
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
                {thread.chordMode && d?.chordMatchRate !== undefined && (
                  <span className="badge">コード一致 {Math.round(d.chordMatchRate * 100)}%</span>
                )}
                {t.gridTiming ? (
                  <span className="badge">ばらつき {Math.round(t.gridTiming.jitterMs)}ms</span>
                ) : d ? (
                  <span className="badge">前回比 {Math.round(d.timingJitterMs)}ms</span>
                ) : null}
              </div>
              {thread.chordMode && t.chordEvents && (
                <div className="meta" style={{ marginTop: 4 }}>
                  {formatProgression(t.chordEvents) || 'コードとして読める区間なし'}
                </div>
              )}
              <div className="row" style={{ marginTop: 6 }}>
                <div className="meta" style={{ flex: 1, marginTop: 0 }}>
                  長さ {(t.durationMs / 1000).toFixed(1)}秒
                  {t.metronome ? ` / ♩=${t.metronome.bpm}` : ''}
                  {t.noteEvents ? ` / 音符${t.noteEvents.length}個検出` : ' / 音符起こし失敗'}
                  {t.suppressedHarmonicCount ? ` / 倍音${t.suppressedHarmonicCount}個除外` : ''}
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
