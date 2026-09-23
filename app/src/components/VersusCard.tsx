import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { diagnose } from '../comparison'
import { useThreadTakesAsc } from '../habit/useThreadTakes'
import {
  judgeAgainstPrev,
  pickDiscovery,
  consecutiveJitterLosses,
  MIN_NOTES_FOR_VERDICT,
  FLAT_JITTER_MS,
  type ItemVerdict,
  type Outcome,
} from '../habit/verdict'

// 診断直後の「前回の自分と」カード。勝敗は verdict.ts の純関数が決め、ここは表示だけ。
// 「勝ち」は前回の自分と比べての意味で、音楽的な正しさではない。注記は必ず出す。

type Props = { threadId: string; takeId: string }

/** 3 連敗以上で勝敗マークを消して文言を切り替える(連敗の可視化で離脱させない) */
const LOSING_STREAK = 3

const MARK: Record<Outcome, string> = { win: '○', draw: '△', loss: '●' }
const MARK_LABEL: Record<Outcome, string> = { win: '前回より小さい', draw: '横ばい', loss: '前回よりばらついた' }

function fmt(v: number, unit: string) {
  return `${Math.round(v)}${unit}`
}

function whenText(ts: number) {
  return new Date(ts).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function tallyText(t: { win: number; draw: number; loss: number }) {
  const parts: string[] = []
  if (t.win) parts.push(`${t.win} 勝`)
  if (t.draw) parts.push(`${t.draw} 分`)
  if (t.loss) parts.push(`${t.loss} 敗`)
  return parts.join(' ')
}

export default function VersusCard({ threadId, takeId }: Props) {
  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId])
  const cur = useLiveQuery(() => db.takes.get(takeId), [takeId])
  const { takesAsc, prevDiagByTake } = useThreadTakesAsc(threadId)

  // 直前テイク = 今見ているテイクより古い normal テイクの最後(actions.recomputeDiagnosis の 'prev' と同じ定義)
  const prev = useMemo(() => {
    if (!cur || !takesAsc) return undefined
    const older = takesAsc.filter((t) => t.id !== cur.id && t.recordedAt < cur.recordedAt)
    return older[older.length - 1]
  }, [cur, takesAsc])
  const prevPrev = useMemo(() => {
    if (!prev || !takesAsc) return undefined
    const older = takesAsc.filter((t) => t.id !== prev.id && t.recordedAt < prev.recordedAt)
    return older[older.length - 1]
  }, [prev, takesAsc])

  // 直前比(prev)の診断。お手本があるスレッドでは保存結果が reference モードで prev が保存されていないので、
  // 無ければその場で計算する(diagnose は音符列から決定的に出る純関数。数十音なら一瞬)
  const curDiag = useMemo(() => {
    if (!cur || !prev || !prevDiagByTake) return undefined
    const saved = prevDiagByTake.get(cur.id)
    if (saved) return saved
    return cur.noteEvents && prev.noteEvents ? diagnose(prev.noteEvents, cur.noteEvents) : undefined
  }, [cur, prev, prevDiagByTake])
  const prevDiag = useMemo(() => {
    if (!prev || !prevPrev || !prevDiagByTake) return undefined
    const saved = prevDiagByTake.get(prev.id)
    if (saved) return saved
    return prev.noteEvents && prevPrev.noteEvents ? diagnose(prevPrev.noteEvents, prev.noteEvents) : undefined
  }, [prev, prevPrev, prevDiagByTake])

  const verdict = useMemo(() => (cur ? judgeAgainstPrev({ cur, prev, curDiag, prevDiag }) : null), [cur, prev, curDiag, prevDiag])
  const discovery = useMemo(
    () => (thread && cur && takesAsc && prevDiagByTake && verdict ? pickDiscovery({ thread, takesAsc, cur, verdict, prevDiagByTake }) : null),
    [thread, cur, takesAsc, prevDiagByTake, verdict],
  )
  const losingStreak = useMemo(
    () => (cur && takesAsc && prevDiagByTake ? consecutiveJitterLosses(takesAsc, prevDiagByTake, cur.id) : 0),
    [cur, takesAsc, prevDiagByTake],
  )

  if (!cur || !verdict) return null
  const hideMarks = losingStreak >= LOSING_STREAK

  return (
    <div className="versus-card">
      <div className="vs-head">
        <div className="ttl">前回の自分と</div>
        {verdict.isDemo && <span className="badge">デモ</span>}
        {prev && <div className="when">前回 {whenText(prev.recordedAt)}</div>}
      </div>

      {!verdict.eligible ? (
        // 判定できないときも枠は出し、理由を書く(可変なのは中身で、出現ではない)
        <div className="vs-reason">{verdict.reason}</div>
      ) : (
        <>
          <div className="vs-grid">
            <div className="vs-col">
              <span className="lbl" />
              <span className="v">前回</span>
              <span className="arrow"> </span>
              <span className="v cur">今回</span>
              <span className="m" />
            </div>
            {verdict.items.map((it) => (
              <VersusRow key={it.key} item={it} hideMark={hideMarks} />
            ))}
          </div>

          {hideMarks ? (
            <div className="vs-reason" style={{ marginTop: 8 }}>
              調子が悪い日もあります。「最も安定したテイクと比較」で見てみましょう。
            </div>
          ) : (
            <div className="vs-tally">{tallyText(verdict.tally)}</div>
          )}

          {verdict.notes.map((n) => (
            <div key={n} className="vs-discovery">
              <span className="k">注記</span>
              {n}
            </div>
          ))}
          {discovery && (
            <div className="vs-discovery">
              <span className="k">発見</span>
              {discovery.text}
            </div>
          )}
        </>
      )}

      <div className="note-block">
        同じように弾けているか(一貫性)の比較です。音楽的な正しさではありません。
        差がばらつき {FLAT_JITTER_MS}ms 未満・一致率 5pt 未満・弾き忘れ 1 個以内なら横ばい(△)、{MIN_NOTES_FOR_VERDICT} 音未満のテイクは比べません。
      </div>
    </div>
  )
}

function VersusRow({ item, hideMark }: { item: ItemVerdict; hideMark: boolean }) {
  return (
    <div className="vs-item">
      <span className="lbl">{item.label}</span>
      <span className="v">{fmt(item.prev, item.unit)}</span>
      <span className="arrow">→</span>
      <span className="v cur">{fmt(item.cur, item.unit)}</span>
      {hideMark ? (
        <span className="vs-mark" />
      ) : (
        <span className={`vs-mark ${item.outcome}`} title={MARK_LABEL[item.outcome]} aria-label={MARK_LABEL[item.outcome]}>
          {MARK[item.outcome]}
        </span>
      )}
      {item.note && <span className="sub">{item.note}</span>}
    </div>
  )
}
