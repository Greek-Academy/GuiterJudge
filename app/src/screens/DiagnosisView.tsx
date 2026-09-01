import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { recomputeDiagnosis } from '../actions'
import { playNoteEvents } from '../preview'
import { alignNoteSequences, type DiagnosisMetrics } from '../comparison'
import PianoRoll, { type PianoRollNote } from '../components/PianoRoll'

type Props = {
  threadId: string
  takeId: string
  onBack: () => void
}

/** 比較モードごとの「この数字が何を意味するか」。取り違えると診断の読み方を誤るので画面に出す */
const MODE_NOTE: Record<'prev' | 'best' | 'reference', string> = {
  prev: '直前のテイクとの比較です。前回と同じように弾けているか(=一貫性)を見ています。',
  best: 'これまでで最も安定していたテイクとの比較です。調子の良かった日を基準にどうか、を見ています。',
  reference:
    'お手本との比較です。自己比較と違い「正しさ」に近い指標になります。自己比較のスコアが高いのにここで落ちる場合、毎回同じ間違いを安定して弾いている可能性があります。',
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

  // 診断メトリクスは集計値なので「どの音がどうズレたか」までは分からない。
  // 表示のためにアライメントをもう一度取り直す(comparison.tsと同じ関数なので結果は一致する)。
  const rollNotes = useMemo<PianoRollNote[]>(() => {
    const ref = comparedTake?.noteEvents
    const cur = take?.noteEvents
    if (!ref || !cur) return []
    return alignNoteSequences(ref, cur).flatMap<PianoRollNote>((p) => {
      if (p.take && p.ref) {
        const { pitch, startMs, durationMs } = p.take
        return [{ pitch, startMs, durationMs, mark: p.ref.pitch === p.take.pitch ? 'match' : 'pitchMismatch' }]
      }
      if (p.take) {
        const { pitch, startMs, durationMs } = p.take
        return [{ pitch, startMs, durationMs, mark: 'extra' }]
      }
      if (p.ref) {
        // 弾き忘れは今回のテイクに音が無いので、基準側の位置に「穴」として描く
        const { pitch, startMs, durationMs } = p.ref
        return [{ pitch, startMs, durationMs, mark: 'missed' }]
      }
      return []
    })
  }, [comparedTake?.noteEvents, take?.noteEvents])

  const ghostNotes = useMemo<PianoRollNote[] | undefined>(
    () =>
      comparedTake?.noteEvents?.map(({ pitch, startMs, durationMs }) => ({ pitch, startMs, durationMs })),
    [comparedTake?.noteEvents],
  )

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
        <div className="note-block">{MODE_NOTE[mode]}</div>

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

            {/* 以前はズレの位置を1次元の帯(deviationTimeline)だけで示していたが、
                それでは「いつ」しか分からず「どの音を」が伝わらなかった。
                ピアノロールに置き換えて、音高方向のズレも同時に読めるようにしている。
                deviationTimelineはデータモデル上は引き続き保存している。 */}
            <div className="section-title">どこがどうズレたか</div>
            {rollNotes.length > 0 ? (
              <div className="chart-block">
                <PianoRoll notes={rollNotes} ghostNotes={ghostNotes} height={190} />
              </div>
            ) : (
              <div className="note-block">音符起こしの結果が無いため、ズレの内訳を表示できません。</div>
            )}
            <div className="note-block">
              薄い灰色は比較対象(基準)のテイクです。色付きが今回のテイクで、基準と照らし合わせた結果を表しています。
            </div>
          </>
        )}
      </div>
    </>
  )
}
