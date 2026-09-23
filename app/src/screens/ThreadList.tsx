import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { createPhraseThread, createSongThroughThread } from '../actions'
import { exportAllData, importAllData } from '../backup'
import { seedDemoData, clearAllData, hasDemoData, type SeedProgress } from '../demo/seed'
import TodaySummary from '../components/TodaySummary'
import TodayHero from '../components/TodayHero'
import StabilityGauge from '../components/StabilityGauge'
import ThreadCardMeta from '../components/ThreadCardMeta'
import { useAllHabitData } from '../habit/useThreadTakes'
import { useStabilityGauge } from '../habit/useStabilityGauge'
import { latestOutcomeByThread, stabilityGauge } from '../habit/verdict'
import { pickToday, warmthClass } from '../habit/pickToday'
import { isChallengeDueToday, useNextChallenge } from '../habit/nextChallenge'

type Props = {
  onOpenThread: (id: string) => void
  /** 「今日の一本」「予告」の ● から。スレッド画面を autoRecord で開く */
  onRecordNow: (id: string) => void
  onOpenSongThrough: (id: string) => void
  onOpenLab: () => void
}

type Notice = { kind: 'success' | 'error'; text: string }

/** 新規スレッド作成の入力欄。window.promptだとプロジェクタにOS標準ダイアログが割り込むため画面内に置く */
type Composing = null | { type: 'phrase' | 'songThrough' }

export default function ThreadList({ onOpenThread, onRecordNow, onOpenSongThrough, onOpenLab }: Props) {
  const [composing, setComposing] = useState<Composing>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [seeding, setSeeding] = useState<SeedProgress | null>(null)
  // window.confirmはプロジェクタにOS標準ダイアログが割り込むので使えないが、
  // 「作り直す」の真下にあるボタンひとつで19テイクが消え、復旧に1〜2分かかるため、
  // 代わりに画面内で2段階にする
  const [confirmingClear, setConfirmingClear] = useState(false)

  const activeThreads = useLiveQuery(
    () => db.threads.where({ type: 'phrase', status: 'active' }).sortBy('lastActivityAt'),
    [],
  )
  const resolvedThreads = useLiveQuery(
    () => db.threads.where({ type: 'phrase', status: 'resolved' }).sortBy('lastActivityAt'),
    [],
  )
  const songThreads = useLiveQuery(() => db.threads.where({ type: 'songThrough' }).toArray(), [])
  const demoLoaded = useLiveQuery(() => hasDemoData(), [])

  // 各スレッドの「最新テイクのばらつき」。
  // メトロノーム録音なら拍に対するばらつき(比較対象なしで出る)、無ければ直前比較のばらつき。
  // 以前はdb.takes.toArray()の返却順(=主キー順。idはUUIDなので実質ランダム)のまま
  // threadIdごとに上書きしていたため、最新とは限らないテイクの値が出ていた。
  // recordedAtの昇順に並べてから上書きすることで、最後に書かれる値が最新テイクのものになる。
  const latestBadges = useLiveQuery(async () => {
    const takes = await db.takes.where('role').equals('normal').sortBy('recordedAt')
    const results = await db.diagnosisResults.toArray()
    const byTakeId = new Map(results.map((r) => [r.takeId, r]))
    const map = new Map<string, string>()
    for (const take of takes) {
      if (take.gridTiming) {
        map.set(take.threadId, `ばらつき ${Math.round(take.gridTiming.jitterMs)}ms`)
        continue
      }
      const r = byTakeId.get(take.id)
      if (r) map.set(take.threadId, `前回比 ${Math.round(r.timingJitterMs)}ms`)
    }
    return map
  }, [])

  // 「今日の一本」の材料。全スレッドのテイクと直前比の診断を 1 度だけ購読し、判定(verdict)→ 候補選定(pickToday)は純関数。
  // 予告は localStorage なので useNextChallenge で購読して、予告する/取り消すの直後に hero が追従するようにする
  // useAllHabitData は毎描画で新しいオブジェクトを返すので、useMemo の依存には中身の 3 つを個別に入れる
  const { threads: habitThreads, takesAsc: habitTakesAsc, prevDiagByTake: habitPrevDiagByTake } = useAllHabitData()
  const challenge = useNextChallenge()
  const heroState = useMemo(() => {
    const [threads, takesAsc, prevDiagByTake] = [habitThreads, habitTakesAsc, habitPrevDiagByTake]
    if (!threads || !takesAsc || !prevDiagByTake) return undefined
    const outcomeByThread = latestOutcomeByThread(takesAsc, prevDiagByTake)
    const gaugeByThread = new Map<string, number>()
    for (const t of threads) {
      if (t.type !== 'phrase' || t.status !== 'active') continue
      const g = stabilityGauge(takesAsc.filter((x) => x.threadId === t.id), prevDiagByTake)
      if (g.available) gaugeByThread.set(t.id, g.value)
    }
    const due = challenge && isChallengeDueToday(challenge) ? challenge : null
    return pickToday({ threads, takesAsc, outcomeByThread, gaugeByThread, challenge: due, prevDiagByTake })
  }, [habitThreads, habitTakesAsc, habitPrevDiagByTake, challenge])
  // 一覧カードの「N テイク」。音符起こしに成功した normal テイクの数(ゲージや hero と同じ母集団)
  const takeCountByThread = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of habitTakesAsc ?? []) m.set(t.threadId, (m.get(t.threadId) ?? 0) + 1)
    return m
  }, [habitTakesAsc])

  function beginCompose(type: 'phrase' | 'songThrough') {
    setComposing({ type })
    setDraftTitle('')
    setNotice(null)
  }

  async function handleCreate() {
    if (!composing) return
    const title = draftTitle.trim()
    if (!title) {
      setNotice({ kind: 'error', text: 'タイトルを入力してください' })
      return
    }
    if (composing.type === 'phrase') {
      const id = await createPhraseThread(title)
      setComposing(null)
      onOpenThread(id)
    } else {
      const id = await createSongThroughThread(title)
      setComposing(null)
      onOpenSongThrough(id)
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { threadCount, takeCount } = await importAllData(file)
      setNotice({ kind: 'success', text: `インポートしました(スレッド${threadCount}件、テイク${takeCount}件)` })
    } catch (err) {
      setNotice({ kind: 'error', text: 'インポートに失敗しました: ' + (err as Error).message })
    } finally {
      e.target.value = ''
    }
  }

  async function handleSeed() {
    setNotice(null)
    setSeeding({ step: 0, total: 1, label: '準備しています…' })
    try {
      const { threadCount, takeCount } = await seedDemoData((p) => setSeeding(p))
      setNotice({
        kind: 'success',
        text: `デモデータを読み込みました(スレッド${threadCount}件、テイク${takeCount}件)`,
      })
    } catch (err) {
      setNotice({ kind: 'error', text: 'デモデータの読み込みに失敗しました: ' + (err as Error).message })
    } finally {
      setSeeding(null)
    }
  }

  async function handleClear() {
    await clearAllData()
    setConfirmingClear(false)
    setNotice({ kind: 'success', text: 'データを削除しました' })
  }

  const seedPercent = seeding ? Math.round((seeding.step / Math.max(1, seeding.total)) * 100) : 0

  return (
    <>
      <div className="topbar">
        <h1>ギター上達診断</h1>
      </div>
      <div style={{ overflowY: 'auto' }}>
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

        {/* 毎日の型: 今日録った日は「今日のまとめ」が先、その下に「今日の一本」。デモテイクは今日分に数えない */}
        <TodaySummary onRecordNow={onRecordNow} />
        <TodayHero
          state={heroState}
          onRecordNow={onRecordNow}
          onOpenThread={onOpenThread}
          onCompose={() => beginCompose('phrase')}
          renderGauge={(id) => <HeroGauge threadId={id} />}
        />

        <div className="section-title">アクティブなスレッド</div>
        {(activeThreads ?? []).map((t) => (
          <div className={`card ${warmthClass(t.lastActivityAt)}`} key={t.id} onClick={() => onOpenThread(t.id)}>
            <div className="row">
              <div className="title">{t.title}</div>
              <StabilityGauge threadId={t.id} compact />
              {latestBadges?.has(t.id) && <div className="badge">{latestBadges.get(t.id)}</div>}
            </div>
            <ThreadCardMeta thread={t} takeCount={takeCountByThread.get(t.id) ?? 0} />
          </div>
        ))}
        {(activeThreads ?? []).length === 0 && !composing && (
          <div className="note-block">
            まだスレッドがありません。練習中に引っかかったフレーズを1つ登録するか、
            下の「デモデータを読み込む」で3週間ぶんの練習履歴を試せます。
          </div>
        )}

        {composing?.type === 'phrase' ? (
          <div className="inline-form">
            <input
              value={draftTitle}
              autoFocus
              placeholder="引っかかっているフレーズ名など"
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
                if (e.key === 'Escape') setComposing(null)
              }}
            />
            <div className="btn-row">
              <button className="primary" onClick={handleCreate}>
                作成する
              </button>
              <button className="secondary" onClick={() => setComposing(null)}>
                やめる
              </button>
            </div>
          </div>
        ) : (
          <button className="new-btn" onClick={() => beginCompose('phrase')}>
            ＋ 新規フレーズスレッド
          </button>
        )}

        <div className="section-title">曲通し</div>
        {(songThreads ?? []).map((t) => (
          <div className="card" key={t.id} onClick={() => onOpenSongThrough(t.id)}>
            <div className="title">{t.title}</div>
          </div>
        ))}
        {composing?.type === 'songThrough' ? (
          <div className="inline-form">
            <input
              value={draftTitle}
              autoFocus
              placeholder="曲名など"
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
                if (e.key === 'Escape') setComposing(null)
              }}
            />
            <div className="btn-row">
              <button className="primary" onClick={handleCreate}>
                作成する
              </button>
              <button className="secondary" onClick={() => setComposing(null)}>
                やめる
              </button>
            </div>
          </div>
        ) : (
          <button className="new-btn" onClick={() => beginCompose('songThrough')}>
            ＋ 新規曲通しスレッド
          </button>
        )}

        {(resolvedThreads ?? []).length > 0 && (
          <>
            <div className="section-title">解決済み</div>
            {(resolvedThreads ?? []).map((t) => (
              <div className="card" style={{ opacity: 0.6, cursor: 'default' }} key={t.id}>
                <div className="row">
                  <div className="title">{t.title}</div>
                  <span className="badge">解決済み</span>
                </div>
              </div>
            ))}
          </>
        )}

        <div className="section-title">デモデータ</div>
        <div className="note-block">
          3週間ぶんの練習履歴を投入します。音声はブラウザ内で合成したもの(実際の録音ではありません)ですが、
          <strong>音符起こしも診断も本番と同じ処理を通しており、表示されるスコアは実際の解析結果です</strong>。
          テイク19件を1件ずつ解析するため、1〜2分ほどかかります(端末の性能によってはもう少しかかります)。
          一度読み込めば端末内に保存されるので、発表の前に済ませておけます。
        </div>
        {seeding ? (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${seedPercent}%` }} />
            </div>
            <div className="meta" style={{ margin: '0 16px' }}>
              {seeding.label}（{seeding.step}/{seeding.total}）
            </div>
          </>
        ) : (
          <div className="stack">
            <button className="secondary" onClick={handleSeed}>
              {demoLoaded ? '🎬 デモデータを作り直す' : '🎬 デモデータを読み込む'}
            </button>
            {demoLoaded &&
              (confirmingClear ? (
                <div className="self-check">
                  <div className="q">
                    デモデータも自分で録音したテイクも、すべて消えます。よろしいですか？
                  </div>
                  <div className="btn-row">
                    <button onClick={handleClear} style={{ color: 'var(--status-critical)' }}>
                      削除する
                    </button>
                    <button onClick={() => setConfirmingClear(false)}>やめる</button>
                  </div>
                </div>
              ) : (
                <button className="secondary danger" onClick={() => setConfirmingClear(true)}>
                  すべてのデータを削除する
                </button>
              ))}
          </div>
        )}

        <div className="section-title">データのバックアップ</div>
        <div className="note-block">
          このアプリのデータは端末内(ブラウザのIndexedDB)にのみ保存され、サーバーには保存されません。
          ブラウザのサイトデータを削除したり、端末のストレージ逼迫時にOSが自動削除した場合、
          復元する手段がありません。時々エクスポートして手元に保管しておくことをおすすめします。
        </div>
        <div className="stack">
          <button className="secondary" onClick={exportAllData}>
            ⬇ データをエクスポート
          </button>
          <label className="secondary" style={{ display: 'block', textAlign: 'center' }}>
            ⬆ バックアップファイルからインポート
            <input type="file" accept="application/json" style={{ display: 'none' }} onChange={handleImport} />
          </label>
        </div>

        <div className="section-title">開発用</div>
        <div className="stack">
          <button className="secondary" onClick={onOpenLab}>
            🔬 音符起こしの検証(M1)
          </button>
        </div>
      </div>
    </>
  )
}

/** hero の中の「解決候補まで ●●●○○ 3/5」。判定できないスレッドでは何も描かない(親の .gauge-line:empty が行ごと消す) */
function HeroGauge({ threadId }: { threadId: string }) {
  const gauge = useStabilityGauge(threadId)
  if (!gauge.available) return null
  return (
    <>
      <span>解決候補まで</span>
      <StabilityGauge threadId={threadId} compact />
      <span className="n">
        {gauge.value}/{gauge.max}
      </span>
    </>
  )
}
