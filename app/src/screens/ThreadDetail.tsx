import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db, { type MetronomeSpec, type Take } from '../db'
import {
  startRecording,
  stopRecordingAndDiagnose,
  setReferenceTakeFromFile,
  setReferenceTakeFromExistingTake,
  clearReferenceTake,
  resolveThread,
  setThreadMetronome,
  setThreadChordMode,
  setThreadTuningLowest,
  type ScoreReferenceResult,
} from '../actions'
import { parseScoreFile, SCORE_FILE_ACCEPT, type ParsedScore, type ScoreConversion } from '../score'
import ScoreImportPanel, { ReferenceAudioButton } from '../components/ScoreImportPanel'
import { playNoteEvents } from '../preview'
import { formatProgression } from '../chordRecognition'
import type { BeatInfo } from '../metronome'
import type { Subdivision } from '../gridTiming'
import ScoreTrend, { type ScoreTrendPoint } from '../components/ScoreTrend'
import { JITTER_METRIC, RELATIVE_JITTER_METRIC } from '../components/trendMetrics'
import StabilityGauge from '../components/StabilityGauge'
import { useStabilityGauge } from '../habit/useStabilityGauge'
import { useThreadTakesAsc } from '../habit/useThreadTakes'
import { GAUGE_MAX } from '../habit/verdict'
import { micPermissionGranted } from '../habit/micPermission'

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
  /** 「今日の一本」「もう 1 回」から来たとき true。マイク許可済みの端末だけ、開いた直後に録音を始める */
  autoRecord?: boolean
}

type Notice = { kind: 'success' | 'error'; text: string }

/** 音域フィルタの下限(Thread.tuningLowest)の選択肢。標準調弦の E2 = 40 が既定 */
const TUNING_LOWEST_OPTIONS: { midi: number; label: string }[] = [
  { midi: 40, label: 'E2(標準調弦)' },
  { midi: 39, label: 'E♭2(半音下げ)' },
  { midi: 38, label: 'D2(ドロップ D / 全音下げ)' },
  { midi: 37, label: 'C♯2' },
  { midi: 36, label: 'C2(ドロップ C)' },
  { midi: 35, label: 'B1(7 弦 / バリトン)' },
]

/** お手本の由来の表示名 */
function referenceLabel(take: Take): string {
  if (take.sourceType === 'importedScore' && take.scoreImport) {
    const si = take.scoreImport
    const range = si.measureFrom !== undefined ? `第 ${si.measureFrom}〜${si.measureTo} 小節` : '全体'
    return `楽譜: ${si.title || si.fileName}、${range}、♩=${si.tempoBpm}`
  }
  switch (take.sourceType) {
    case 'demo':
      return 'デモ音源'
    case 'importedAudio':
      return '音声ファイル'
    case 'importedVideo':
      return '動画ファイル'
    case 'importedScore':
      return '楽譜'
    default:
      return '過去テイク'
  }
}

function tuningLabel(midi: number): string {
  return TUNING_LOWEST_OPTIONS.find((o) => o.midi === midi)?.label ?? String(midi)
}

export default function ThreadDetail({ threadId, onBack, onOpenDiagnosis, autoRecord = false }: Props) {
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
  /** 楽譜ファイルを選んだ後の取り込みパネル。null なら閉じている */
  const [scoreParsed, setScoreParsed] = useState<ParsedScore | null>(null)

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
  // 安定ゲージ(直前のテイクと同じように弾けた回数)。満タンなら解決ボタンを主ボタンに昇格させるだけで、自動では解決しない
  const gauge = useStabilityGauge(threadId)
  const gaugeFull = gauge.available && gauge.value >= GAUGE_MAX
  const referenceTake = useLiveQuery(() => db.takes.where({ threadId, role: 'reference' }).first(), [threadId])
  // 直前比(compareMode 'prev')の診断。保存済みが無いテイク(お手本ありスレッドなど)はその場で計算して埋めてある。
  // ゲージ・対戦カードと同じ判定源なので、推移グラフの数字もそれらと揃う
  const { prevDiagByTake } = useThreadTakesAsc(threadId)
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
  // お手本ありスレッドの保存済み診断はお手本との比較なので使わず、直前比の Map(prevDiagByTake)から引く。
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
      const d = prevDiagByTake?.get(t.id)
      if (!d) continue
      points.push({ at: t.recordedAt, value: d.timingJitterMs, label: `${(t.durationMs / 1000).toFixed(1)}秒` })
      takeIds.push(t.id)
    }
    return { points, takeIds, metric: RELATIVE_JITTER_METRIC }
  }, [takes, prevDiagByTake])

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

  // autoRecord で開いたとき、メトロノーム設定の読み込みを待ってから 1 度だけ録音を始める。
  // 初回はマイク許可ダイアログが出るので「開いたら勝手に録音」に見せない。許可済みのときだけ自動で始め、
  // 未許可・非対応の端末では従来どおりボタンを押してもらう(案内を 1 行出す)
  // 許可の問い合わせ(await)中に画面を離れたら録音を始めない(離れた画面の裏でマイクが開くのを防ぐ)。
  // cleanup で cancelled を立て、まだ始めていなければ autoStarted も戻す。StrictMode(開発時)の
  // マウント → 即アンマウント → 再マウントでも、2 回目の effect で改めて 1 度だけ始められるようにするため
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoRecord || !metroLoaded || autoStarted.current || isRecording || busy) return
    autoStarted.current = true
    let cancelled = false
    let started = false
    void (async () => {
      const granted = await micPermissionGranted()
      if (cancelled) return
      started = true
      if (granted) await handleRecordToggle()
      else setNotice({ kind: 'success', text: '「● 録音する」を押すと始まります(初回はマイクの許可が必要です)' })
    })()
    return () => {
      cancelled = true
      if (!started) autoStarted.current = false
    }
    // handleRecordToggle / isRecording / busy は毎描画で変わるが、autoStarted で 1 回に絞っているので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecord, metroLoaded])

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

  async function handleScoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setNotice(null)
    try {
      setScoreParsed(await parseScoreFile(file, file.name))
    } catch (err) {
      setScoreParsed(null)
      setNotice({ kind: 'error', text: '楽譜ファイルを読み込めませんでした: ' + (err as Error).message })
    }
  }

  function handleScoreDone(result: ScoreReferenceResult, conv: ScoreConversion) {
    setScoreParsed(null)
    let text = `楽譜からお手本を作りました(${conv.notes.length} 音、♩=${Math.round(conv.tempoBpm * 10) / 10})`
    if (result.tuningLoweredTo !== undefined) {
      text += `。楽譜に標準調弦より低い音があるので、このスレッドの最低音を ${tuningLabel(result.tuningLoweredTo)} に下げました`
    }
    setNotice({ kind: 'success', text })
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

  const scoreFileButton = (
    <label className="secondary" style={{ display: 'block', textAlign: 'center' }}>
      楽譜ファイルから(.musicxml / .mxl)
      <input
        type="file"
        accept={SCORE_FILE_ACCEPT}
        style={{ display: 'none' }}
        onChange={handleScoreFile}
        disabled={busy}
        data-testid="score-file-input"
      />
    </label>
  )
  const scorePanel = scoreParsed && (
    <ScoreImportPanel
      key={scoreParsed.fileName + scoreParsed.byteLength}
      thread={thread}
      parsed={scoreParsed}
      onDone={handleScoreDone}
      onCancel={() => setScoreParsed(null)}
      onError={(message) => setNotice({ kind: 'error', text: 'お手本を作れませんでした: ' + message })}
    />
  )

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
                        <button
                          type="button"
                          key={s.value}
                          className={`pill ${metro.subdivision === s.value ? 'active' : ''}`}
                          aria-pressed={metro.subdivision === s.value}
                          onClick={() => updateMetro({ subdivision: s.value })}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="row metro-row">
                    <span className="lbl">カウントイン</span>
                    <div className="pill-row" style={{ margin: 0, flex: 1 }}>
                      {[0, 2, 4, 8].map((n) => (
                        <button
                          type="button"
                          key={n}
                          className={`pill ${metro.countInBeats === n ? 'active' : ''}`}
                          aria-pressed={metro.countInBeats === n}
                          onClick={() => updateMetro({ countInBeats: n })}
                        >
                          {n === 0 ? 'なし' : `${n}拍`}
                        </button>
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
            {/* 変則調弦。音符起こしの音域フィルタは標準調弦の最低音 E2 より下を捨てるので、
                ドロップ D 等では 6 弦の音が消える。下限だけをスレッド単位で下げられるようにする */}
            <div className="metro-panel">
              <div className="row metro-row">
                <span className="lbl">最低音</span>
                <select
                  value={thread.tuningLowest ?? 40}
                  disabled={busy}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    void setThreadTuningLowest(threadId, v === 40 ? null : v)
                  }}
                >
                  {TUNING_LOWEST_OPTIONS.map((o) => (
                    <option key={o.midi} value={o.midi}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {(thread.tuningLowest ?? 40) !== 40 && (
                <div className="meta" style={{ margin: 0 }}>
                  この設定以降に録るテイクに効きます。すでに録ったテイクは起こし直しません。
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
        {/* 解決候補までの安定ゲージ。満タンでも解決は下のボタン+自己確認で人が決める */}
        <StabilityGauge threadId={threadId} />

        <div className="section-title">お手本(任意)</div>
        {referenceTake ? (
          <>
            <div className="card" style={{ cursor: 'default' }}>
              <div className="row">
                <div className="title">
                  お手本({referenceLabel(referenceTake)})
                </div>
                {/* 保存済みの音声(楽譜由来なら合成音)。音符列の簡易音は「▶ 音符」 */}
                {referenceTake.audioBlob && referenceTake.audioBlob.size > 0 && (
                  <ReferenceAudioButton key={referenceTake.id} blob={referenceTake.audioBlob} />
                )}
                {referenceTake.noteEvents && (
                  <button
                    className="secondary"
                    style={{ width: 'auto', padding: '4px 10px' }}
                    onClick={() => playNoteEvents(referenceTake.noteEvents!)}
                    aria-label="お手本の音符列を簡易音で鳴らす"
                  >
                    ▶ 音符
                  </button>
                )}
              </div>
              <div className="meta">
                {new Date(referenceTake.recordedAt).toLocaleString('ja-JP')} / 長さ{' '}
                {(referenceTake.durationMs / 1000).toFixed(1)}秒
                {referenceTake.scoreImport &&
                  ` / ${referenceTake.scoreImport.notes}音 / ${referenceTake.scoreImport.fileName}` +
                    (referenceTake.scoreImport.software ? `(${referenceTake.scoreImport.software})` : '')}
              </div>
              {referenceTake.sourceType === 'importedScore' && (
                <div className="meta">
                  楽譜どおりの格子(指定テンポ)との比較になります。「ばらつき」は格子からのずれ、「テンポ差」は指定 BPM との差です。
                </div>
              )}
            </div>
            {scoreParsed && scorePanel}
            <div className="stack" style={scoreParsed ? { display: 'none' } : undefined}>
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
              {scoreFileButton}
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
              講師などの録音を取り込むか、手持ちの楽譜ファイル(MusicXML)から作るか、下のテイク履歴から自分のうまく弾けたテイクを選べます。
              PDF の楽譜は MuseScore 4(無料)や Soundslice で MusicXML にしてから取り込めます。
            </div>
            {scoreParsed && scorePanel}
            <div className="stack" style={scoreParsed ? { display: 'none' } : undefined}>
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
              {scoreFileButton}
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
          // 「前回比」バッジは直前比だけ。保存済み d はお手本比較のことがあるので、推移グラフと同じ Map から引く
          const pd = prevDiagByTake?.get(t.id)
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
                ) : pd ? (
                  <span className="badge">前回比 {Math.round(pd.timingJitterMs)}ms</span>
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
              className={gaugeFull ? 'primary' : 'secondary'}
              style={{ margin: '14px 16px', width: 'calc(100% - 32px)' }}
              onClick={() => setShowSelfCheck(true)}
            >
              {gaugeFull ? `✓ 安定 ${GAUGE_MAX} 回。解決済みにしますか?` : '✓ このスレッドを解決済みにする'}
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
