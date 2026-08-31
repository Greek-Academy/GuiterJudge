import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { recomputeDiagnosis } from '../actions'
import { playNoteEvents } from '../preview'
import type { DiagnosisMetrics } from '../comparison'

type Props = {
  threadId: string
  takeId: string
  onBack: () => void
}

const severityColor: Record<number, string> = {
  0: 'transparent',
  1: 'var(--status-warning)',
  2: 'var(--status-critical)',
}

export default function DiagnosisView({ threadId, takeId, onBack }: Props) {
  const [mode, setMode] = useState<'prev' | 'best' | 'reference'>('prev')
  const [result, setResult] = useState<(DiagnosisMetrics & { comparedToTakeId: string }) | null | undefined>(undefined)

  const take = useLiveQuery(() => db.takes.get(takeId), [takeId])
  const referenceTake = useLiveQuery(() => db.takes.where({ threadId, role: 'reference' }).first(), [threadId])
  const comparedTake = useLiveQuery(
    () => (result ? db.takes.get(result.comparedToTakeId) : undefined),
    [result?.comparedToTakeId],
  )

  useEffect(() => {
    let cancelled = false
    setResult(undefined)
    recomputeDiagnosis(threadId, takeId, mode).then((r) => {
      if (!cancelled) setResult(r ? { ...r.metrics, comparedToTakeId: r.comparedToTakeId } : null)
    })
    return () => {
      cancelled = true
    }
  }, [threadId, takeId, mode])

  if (!take) return null

  return (
    <>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>
          ← 戻る
        </button>
        <h1>診断結果</h1>
      </div>
      <div style={{ overflowY: 'auto' }}>
        <div className="pill-row">
          <div className={`pill ${mode === 'prev' ? 'active' : ''}`} onClick={() => setMode('prev')}>
            直前のテイクと比較
          </div>
          <div className={`pill ${mode === 'best' ? 'active' : ''}`} onClick={() => setMode('best')}>
            最も安定したテイクと比較
          </div>
          {referenceTake && (
            <div className={`pill ${mode === 'reference' ? 'active' : ''}`} onClick={() => setMode('reference')}>
              お手本と比較
            </div>
          )}
        </div>

        <div className="row" style={{ margin: '0 16px', gap: 8 }}>
          {take.noteEvents && (
            <button className="secondary" onClick={() => playNoteEvents(take.noteEvents!)}>
              ▶ 今回のテイクを再生
            </button>
          )}
          {comparedTake?.noteEvents && (
            <button className="secondary" onClick={() => playNoteEvents(comparedTake.noteEvents!)}>
              ▶ 比較対象を再生
            </button>
          )}
        </div>

        {result === undefined && <div className="note-block">計算中...</div>}
        {result === null && (
          <div className="note-block">
            比較対象がありません(このモードで比較できるテイクがまだない、またはこのテイクの音符起こしに失敗しています)。
          </div>
        )}
        {result && (
          <>
            <div className="stat-hero">
              <div className="lbl">安定度スコア</div>
              <div className="val">{result.stabilityScore}</div>
              <div className="note-block" style={{ margin: '4px 0 0' }}>
                ※これは「一貫性/変化」の指標であり、音楽的な正しさそのものを判定するものではありません
              </div>
            </div>
            <div className="metric-grid">
              <div className="metric">
                <div className="lbl">音符一致率</div>
                <div className="val">{Math.round(result.noteMatchRate * 100)}%</div>
              </div>
              <div className="metric">
                <div className="lbl">タイミングのズレ</div>
                <div className="val">{result.timingDriftMs}ms</div>
              </div>
              <div className="metric">
                <div className="lbl">弾き忘れ/余分な音</div>
                <div className="val">{result.missedOrExtraNoteCount}</div>
              </div>
            </div>
            <div className="section-title">どこがズレたか(基準テイクの時間軸)</div>
            <div className="timeline-track">
              {result.deviationTimeline.map((seg, i) => {
                const totalMs = result.deviationTimeline.length
                  ? result.deviationTimeline[result.deviationTimeline.length - 1].endMs
                  : 1
                const leftPct = (seg.startMs / totalMs) * 100
                const widthPct = ((seg.endMs - seg.startMs) / totalMs) * 100
                return (
                  <div
                    key={i}
                    className="timeline-seg"
                    style={{ left: `${leftPct}%`, width: `${widthPct}%`, background: severityColor[seg.severity] }}
                  />
                )
              })}
            </div>
            <div className="legend-row">
              <span>
                <span className="dot" style={{ background: 'var(--status-warning)' }}></span>タイミングのズレ
              </span>
              <span>
                <span className="dot" style={{ background: 'var(--status-critical)' }}></span>音の間違い/弾き忘れ
              </span>
            </div>
          </>
        )}
      </div>
    </>
  )
}
