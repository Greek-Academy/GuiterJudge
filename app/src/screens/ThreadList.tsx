import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { createPhraseThread, createSongThroughThread } from '../actions'
import { exportAllData, importAllData } from '../backup'

type Props = {
  onOpenThread: (id: string) => void
  onOpenSongThrough: (id: string) => void
  onOpenLab: () => void
}

export default function ThreadList({ onOpenThread, onOpenSongThrough, onOpenLab }: Props) {
  const activeThreads = useLiveQuery(
    () => db.threads.where({ type: 'phrase', status: 'active' }).sortBy('lastActivityAt'),
    [],
  )
  const resolvedThreads = useLiveQuery(
    () => db.threads.where({ type: 'phrase', status: 'resolved' }).sortBy('lastActivityAt'),
    [],
  )
  const songThreads = useLiveQuery(() => db.threads.where({ type: 'songThrough' }).toArray(), [])
  const latestScores = useLiveQuery(async () => {
    const results = await db.diagnosisResults.toArray()
    const takes = await db.takes.toArray()
    const map = new Map<string, number>() // threadId -> latest stabilityScore
    for (const take of takes) {
      const r = results.filter((x) => x.takeId === take.id)[0]
      if (r) map.set(take.threadId, r.stabilityScore)
    }
    return map
  }, [])

  async function handleNewPhrase() {
    const title = window.prompt('スレッドのタイトル(引っかかっているフレーズ名など)')
    if (!title) return
    const id = await createPhraseThread(title)
    onOpenThread(id)
  }

  async function handleNewSongThrough() {
    const title = window.prompt('曲通しスレッドのタイトル(曲名など)')
    if (!title) return
    const id = await createSongThroughThread(title)
    onOpenSongThrough(id)
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { threadCount, takeCount } = await importAllData(file)
      alert(`インポートしました(スレッド${threadCount}件、テイク${takeCount}件)`)
    } catch (err) {
      alert('インポートに失敗しました: ' + (err as Error).message)
    } finally {
      e.target.value = ''
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>ギター上達診断</h1>
      </div>
      <div style={{ overflowY: 'auto' }}>
        <div className="section-title">アクティブなスレッド</div>
        {(activeThreads ?? []).map((t) => (
          <div className="card" key={t.id} onClick={() => onOpenThread(t.id)}>
            <div className="row">
              <div className="title">{t.title}</div>
              {latestScores?.has(t.id) && <div className="badge">安定度 {latestScores.get(t.id)}</div>}
            </div>
            <div className="meta">最終更新: {new Date(t.lastActivityAt).toLocaleString('ja-JP')}</div>
          </div>
        ))}
        <button className="new-btn" onClick={handleNewPhrase}>
          ＋ 新規フレーズスレッド
        </button>

        <div className="section-title">曲通し</div>
        {(songThreads ?? []).map((t) => (
          <div className="card" key={t.id} onClick={() => onOpenSongThrough(t.id)}>
            <div className="title">{t.title}</div>
          </div>
        ))}
        <button className="new-btn" onClick={handleNewSongThrough}>
          ＋ 新規曲通しスレッド
        </button>

        <div className="section-title">解決済み</div>
        {(resolvedThreads ?? []).map((t) => (
          <div className="card" style={{ opacity: 0.6, cursor: 'default' }} key={t.id}>
            <div className="row">
              <div className="title">{t.title}</div>
              <span className="badge">解決済み</span>
            </div>
          </div>
        ))}

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
