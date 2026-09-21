import type { ChordEvent, ChordAlignmentPair } from '../chordRecognition'
import { chordProgression } from '../chordRecognition'

// コード進行を横一列の帯で描く。ピアノロール(PianoRoll.tsx)の和音版。
// 上段が比較対象、下段が今回のテイク。対応付け(pairs)があれば、今回側の各コードを
// 一致 / 別のコード / 余分 で色分けし、比較対象側の「抜け」も印を付ける。
// ブロック数はせいぜい数十なので、Canvas ではなく素の div で十分。

export type ChordTimelineProps = {
  take: ChordEvent[]
  ref?: ChordEvent[]
  pairs?: ChordAlignmentPair[]
}

type Mark = 'plain' | 'match' | 'mismatch' | 'extra' | 'missed'

function marksFor(pairs: ChordAlignmentPair[] | undefined): { take: Map<ChordEvent, Mark>; ref: Map<ChordEvent, Mark> } {
  const take = new Map<ChordEvent, Mark>()
  const ref = new Map<ChordEvent, Mark>()
  for (const p of pairs ?? []) {
    if (p.ref && p.take) {
      const m: Mark = p.ref.label === p.take.label ? 'match' : 'mismatch'
      take.set(p.take, m)
      ref.set(p.ref, m)
    } else if (p.take) take.set(p.take, 'extra')
    else if (p.ref) ref.set(p.ref, 'missed')
  }
  return { take, ref }
}

function Row({
  label,
  events,
  marks,
  totalMs,
  ghost,
}: {
  label: string
  events: ChordEvent[]
  marks: Map<ChordEvent, Mark>
  totalMs: number
  ghost?: boolean
}) {
  return (
    <div className="chord-row">
      <div className="chord-row-label">{label}</div>
      <div className={`chord-track ${ghost ? 'ghost' : ''}`}>
        {events.map((e, i) => {
          const left = (e.startMs / totalMs) * 100
          const width = Math.max(0.5, ((e.endMs - e.startMs) / totalMs) * 100)
          const mark = marks.get(e) ?? 'plain'
          return (
            <div
              key={i}
              className={`chord-seg ${mark}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${e.label} ${Math.round(e.startMs)}–${Math.round(e.endMs)}ms (類似度 ${Math.round(e.confidence * 100)}%)`}
            >
              <span>{e.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function ChordTimeline({ take, ref, pairs }: ChordTimelineProps) {
  // 比較には N(無音)を落として同じコードを畳んだ進行を使っている(diagnoseChords と同じ)ので、
  // 表示も同じ単位に揃える。pairs の中の ChordEvent はこの畳んだ後のオブジェクトなので、
  // ここでも同じ関数を通した結果と参照が一致するよう、pairs 側から拾い直す
  const takeProg = pairs ? pairs.flatMap((p) => (p.take ? [p.take] : [])) : chordProgression(take)
  const refProg = pairs ? pairs.flatMap((p) => (p.ref ? [p.ref] : [])) : ref ? chordProgression(ref) : []
  const totalMs = Math.max(1, ...takeProg.map((e) => e.endMs), ...refProg.map((e) => e.endMs))
  const marks = marksFor(pairs)

  return (
    <div className="chord-timeline">
      {refProg.length > 0 && <Row label="比較対象" events={refProg} marks={marks.ref} totalMs={totalMs} ghost />}
      <Row label="今回" events={takeProg} marks={marks.take} totalMs={totalMs} />
      {pairs && (
        <div className="legend-row">
          <span>
            <span className="dot" style={{ background: 'var(--series-1)' }} />
            一致
          </span>
          <span>
            <span className="dot" style={{ background: 'var(--status-critical)' }} />
            別のコード
          </span>
          <span>
            <span className="dot" style={{ background: 'var(--chart-extra)' }} />
            余分
          </span>
          <span>
            <span className="dot" style={{ background: 'var(--baseline)' }} />
            抜け(比較対象側)
          </span>
        </div>
      )}
    </div>
  )
}
