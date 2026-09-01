import { useEffect, useMemo, useRef, useState } from 'react'
import { pitchToName } from '../pitchNames'

// 音符列をピアノロール(横=時間 / 縦=音高)で描くコンポーネント。
// 用途は2つあり、どちらも「並び方の異常が形として見えること」が目的:
//   1. 診断画面: 比較対象(ghostNotes)の上に今回のテイクを重ね、一致/音程違い/弾き忘れ/余分を色と形で示す
//   2. M1検証画面: 検出音の3〜4割を占める倍音由来の誤検出が「平行に並んだ帯」として見えるようにする
// SVGだと音符数が数百になったときにDOMノードが増えすぎるので、Canvas 2Dで描いている。

export type PianoRollMark = 'plain' | 'match' | 'pitchMismatch' | 'missed' | 'extra'

export type PianoRollNote = {
  pitch: number // MIDIノート番号
  startMs: number
  durationMs: number
  mark?: PianoRollMark // 省略時は 'plain'
}

export type PianoRollProps = {
  notes: PianoRollNote[]
  /** 描画高さ(px)。既定 180 */
  height?: number
  /** 比較対象などを薄く重ねる下地レイヤー */
  ghostNotes?: PianoRollNote[]
  /** 縦軸(音高)の範囲を固定したい場合。省略時は notes と ghostNotes から自動算出 */
  pitchRange?: { min: number; max: number }
  /** 倍音由来の誤検出候補に印を付ける(M1検証画面で使う)。既定 false */
  showHarmonicGuides?: boolean
}

// --- デザイントークン ---------------------------------------------------
// App.cssのCSS変数をJS側から読むのは(canvasの描画タイミングと相性が悪く)面倒なので、
// 同じ値をここに定数として持つ。値を変えるときはApp.cssと両方直すこと。
const SURFACE = '#fcfcfb' // --surface-1
const GRIDLINE = '#e1e0d9' // --gridline
const BASELINE = '#c3c2b7' // --baseline
const TEXT_MUTED = '#898781' // --text-muted
const TEXT_SECONDARY = '#52514e' // --text-secondary
const SERIES_1 = '#2a78d6' // --series-1
const CRITICAL = '#d03b3b' // --status-critical
// --status-warning(#fab219)は白背景に対するコントラストが1.79:1しかなく、
// 細い帯のマークとしては見えないため、チャート用に暗くした変種を使う(コントラスト3:1以上)。
const AMBER_CHART = '#b8801a'

// 赤(#d03b3b)とアンバー(#b8801a)は第2色覚では区別しにくい(deutan ΔE 6.9)。
// そのため塗り/中空/ハッチという「形」でも必ず区別できるようにしている。色だけに頼らないこと。

const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif'

const PAD_LEFT = 32 // Cの音名ラベル("C3"など)を置く左の余白
const PAD_RIGHT = 8 // 最後の音符が右端で切れないための余白
const PAD_TOP = 6
const AXIS_H = 16 // 下端の秒数ラベル用

/** 倍音の関係にある半音差。基音に対して +12(1oct) / +19(1oct+5度) / +24(2oct) / +28(2oct+長3度) */
const HARMONIC_INTERVALS = [12, 19, 24, 28]

const MARK_LABEL: Record<PianoRollMark, string> = {
  plain: '検出音',
  match: '一致',
  pitchMismatch: '音程違い',
  missed: '弾き忘れ',
  extra: '余分な音',
}

// 凡例の並び順。実際に登場したマークだけをこの順で出す
const MARK_ORDER: PianoRollMark[] = ['plain', 'match', 'pitchMismatch', 'missed', 'extra']

// props未指定時に毎回新しい配列を作るとuseEffectの依存が毎レンダリング変わるので、共有の空配列を使う
const EMPTY_NOTES: PianoRollNote[] = []

type HarmonicPair = { suspect: number; fundamental: number }

/**
 * 同時刻(±toleranceMs)に +12/+19/+24/+28 半音の関係で重なっている音を、
 * 倍音由来の誤検出候補とみなし、その「上側の音」のインデックスを返す。
 * 基音側は実音の可能性が高いので候補に入れない。
 */
function findHarmonicPairs(notes: PianoRollNote[], toleranceMs = 80): HarmonicPair[] {
  const pairs: HarmonicPair[] = []
  // 音符数はM1の実測で高々数百なので、素直な総当たりで足りる(区間木などは持ち込まない)
  for (let i = 0; i < notes.length; i++) {
    let best: HarmonicPair | null = null
    let bestGap = Infinity
    for (let j = 0; j < notes.length; j++) {
      if (i === j) continue
      const gap = Math.abs(notes[i].startMs - notes[j].startMs)
      if (gap > toleranceMs) continue
      if (!HARMONIC_INTERVALS.includes(notes[i].pitch - notes[j].pitch)) continue
      // 同じ音に複数の基音候補があるときは、発音時刻が最も近いものを補助線の相手にする
      if (gap < bestGap) {
        bestGap = gap
        best = { suspect: i, fundamental: j }
      }
    }
    if (best) pairs.push(best)
  }
  return pairs
}

/**
 * 同時刻(±toleranceMs)に +12/+19/+24/+28 半音の関係で重なっている音を、
 * 倍音由来の誤検出候補とみなして、そのインデックス集合を返す。
 * toleranceMs の既定は 80。
 */
// 仕様上この関数はPianoRollと同じファイルから公開すると決まっているため、
// 「コンポーネント以外をexportするとFast Refreshが効かない」警告はここだけ許容する。
// eslint-disable-next-line react/only-export-components
export function findHarmonicSuspects(notes: PianoRollNote[], toleranceMs = 80): Set<number> {
  return new Set(findHarmonicPairs(notes, toleranceMs).map((p) => p.suspect))
}

/** roundRectはSafari 16.4未満に無い。PWAの対象端末を絞りたくないので自前でパスを引く */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

/** 秒グリッドのラベル間隔。ラベル同士が40px以上離れる最小の刻みを選ぶ(重なり防止) */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
function pickTickStepSec(pxPerSec: number): number {
  for (const s of TICK_STEPS) {
    if (s * pxPerSec >= 40) return s
  }
  return TICK_STEPS[TICK_STEPS.length - 1]
}

type LaidOutNote = { x: number; y: number; w: number; h: number; note: PianoRollNote; suspect: boolean }

export default function PianoRoll({
  notes,
  height = 180,
  ghostNotes,
  pitchRange,
  showHarmonicGuides = false,
}: PianoRollProps) {
  const ghosts = ghostNotes ?? EMPTY_NOTES
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 当たり判定用の矩形。stateに置くと描画→setState→再描画のループになるのでrefで持つ
  const rectsRef = useRef<LaidOutNote[]>([])
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<LaidOutNote | null>(null)

  const suspects = useMemo(
    () => (showHarmonicGuides ? findHarmonicPairs(notes) : []),
    [notes, showHarmonicGuides],
  )
  const suspectSet = useMemo(() => new Set(suspects.map((p) => p.suspect)), [suspects])

  // 親要素いっぱいに伸縮させたいので、実幅はResizeObserverで測る
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setWidth(Math.max(0, Math.floor(w)))
    })
    ro.observe(el)
    setWidth(Math.max(0, Math.floor(el.clientWidth)))
    return () => ro.disconnect()
  }, [])

  const usedMarks = useMemo(() => {
    const set = new Set<PianoRollMark>()
    for (const n of notes) set.add(n.mark ?? 'plain')
    return set
  }, [notes])
  // 「全部ただの音符」なら凡例は情報量ゼロなので出さない
  const showLegend = MARK_ORDER.some((m) => m !== 'plain' && usedMarks.has(m)) || showHarmonicGuides

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // devicePixelRatio対応。CSS上は width:100% のまま、裏のビットマップだけ倍率をかける
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = SURFACE
    ctx.fillRect(0, 0, width, height)
    ctx.font = FONT
    ctx.textBaseline = 'alphabetic'

    rectsRef.current = []

    const all = [...notes, ...ghosts]
    if (all.length === 0) {
      ctx.strokeStyle = BASELINE
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
      ctx.fillStyle = TEXT_MUTED
      ctx.textAlign = 'center'
      ctx.fillText('音符がありません', width / 2, height / 2 + 4)
      ctx.textAlign = 'left'
      return
    }

    const plotX = PAD_LEFT
    const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT)
    const plotY = PAD_TOP
    const plotH = Math.max(1, height - PAD_TOP - AXIS_H)

    // --- 縦軸(音高)のスケール ---
    let lo: number
    let hi: number
    if (pitchRange) {
      lo = Math.min(pitchRange.min, pitchRange.max)
      hi = Math.max(pitchRange.min, pitchRange.max)
    } else {
      lo = Math.min(...all.map((n) => n.pitch)) - 1 // 上下に1半音の余白
      hi = Math.max(...all.map((n) => n.pitch)) + 1
    }
    // 音が1つしか無いときに帯が画面いっぱいになるのを防ぐため、最低5半音は確保する
    const MIN_SEMITONES = 5
    if (hi - lo + 1 < MIN_SEMITONES) {
      const need = MIN_SEMITONES - (hi - lo + 1)
      lo -= Math.floor(need / 2)
      hi += Math.ceil(need / 2)
    }
    const rows = hi - lo + 1
    const band = plotH / rows
    const yOf = (pitch: number) => plotY + (hi - pitch) * band

    // --- 横軸(時間)のスケール ---
    const totalMs = Math.max(1000, ...all.map((n) => n.startMs + n.durationMs))
    const xOf = (ms: number) => plotX + (ms / totalMs) * plotW
    const pxPerSec = (plotW / totalMs) * 1000

    // --- グリッド ---
    ctx.lineWidth = 1
    ctx.strokeStyle = GRIDLINE
    // 横線はCの音(pitch % 12 === 0)にだけ。破線はノイズになるので実線のヘアライン。
    // 帯が潰れるほど音域が広いときだけ、線とラベルを2オクターブ・3オクターブ刻みに間引く
    let octStep = 1
    while (band * 12 * octStep < 13) octStep++
    const firstC = Math.ceil(lo / 12) * 12
    ctx.fillStyle = TEXT_MUTED
    ctx.textAlign = 'left'
    let drewPitchLabel = false
    let lastLabelY = Infinity
    for (let p = firstC; p <= hi; p += 12 * octStep) {
      const y = Math.round(yOf(p) + band) + 0.5 // Cの帯の下端に引く
      if (y < plotY || y > plotY + plotH) continue
      ctx.beginPath()
      ctx.moveTo(plotX, y)
      ctx.lineTo(plotX + plotW, y)
      ctx.stroke()
      // 音名はCだけ。全音に振ると左端が文字で埋まって読めなくなる。
      // 枠外にはみ出す上端のCと、直前のラベルと重なる位置のCはラベルを省く(線だけ残す)
      const labelY = y - 1
      if (labelY >= plotY + 9 && lastLabelY - labelY >= 12) {
        ctx.fillText(pitchToName(p), 4, labelY)
        lastLabelY = labelY
        drewPitchLabel = true
      }
    }
    if (!drewPitchLabel) {
      // 音域が狭くてCが1つも入らないと縦軸に手掛かりがゼロになるので、上下端の音名を出す
      ctx.fillText(pitchToName(hi), 4, plotY + 9)
      ctx.fillText(pitchToName(lo), 4, plotY + plotH - 1)
    }

    // 縦線は1秒ごと。ただし1秒が8px未満まで詰まると線の壁になるのでラベル刻みに合わせる
    const labelStepSec = pickTickStepSec(pxPerSec)
    const gridStepSec = pxPerSec >= 8 ? 1 : labelStepSec
    const totalSec = totalMs / 1000
    ctx.strokeStyle = GRIDLINE
    for (let s = gridStepSec; s <= totalSec; s += gridStepSec) {
      const x = Math.round(xOf(s * 1000)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, plotY)
      ctx.lineTo(x, plotY + plotH)
      ctx.stroke()
    }
    // 時間軸のベースライン
    ctx.strokeStyle = BASELINE
    ctx.beginPath()
    ctx.moveTo(plotX, Math.round(plotY + plotH) + 0.5)
    ctx.lineTo(plotX + plotW, Math.round(plotY + plotH) + 0.5)
    ctx.stroke()

    // 秒数ラベル(控えめに)。単位は既存画面の"120ms"表記に合わせて英字1文字にする
    ctx.fillStyle = TEXT_MUTED
    for (let s = 0; s <= totalSec; s += labelStepSec) {
      const x = xOf(s * 1000)
      const label = `${s}s`
      const w = ctx.measureText(label).width
      // 端で切れないようにクランプする
      const tx = Math.min(Math.max(x - w / 2, 2), width - w - 2)
      ctx.fillText(label, tx, height - 4)
    }

    // --- 音符の矩形 ---
    // 帯の70%にして上下に隙間を作る。ただし音域が広いと1音が1px未満になり
    // 塗り/中空/ハッチの区別が消えるので、最低2.5pxは確保する
    const noteH = Math.max(2.5, Math.min(band * 0.7, band - 1))
    // 重なりを分離するサーフェス色のリングは、帯が細いと矩形の中身まで食い潰してしまう。
    // 帯の高さに応じて細くし、そもそも重なりが視認できない細さでは省く
    const ringWidth = noteH >= 6 ? 2 : noteH >= 3.5 ? 1 : 0
    const rectOf = (n: PianoRollNote) => {
      const x = xOf(n.startMs)
      const w = Math.max(2, xOf(n.startMs + n.durationMs) - x) // 極端に短い音も見えるように最低2px
      const y = yOf(n.pitch) + (band - noteH) / 2
      return { x, y, w, h: noteH }
    }

    // ghostは最背面。比較対象は「下地」であって主役ではないので薄く敷くだけ
    ctx.globalAlpha = 0.3
    ctx.fillStyle = BASELINE
    for (const n of ghosts) {
      const r = rectOf(n)
      roundRectPath(ctx, r.x, r.y, r.w, r.h, 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      const mark = n.mark ?? 'plain'
      const r = rectOf(n)
      const suspect = suspectSet.has(i)
      rectsRef.current.push({ ...r, note: n, suspect })

      roundRectPath(ctx, r.x, r.y, r.w, r.h, 2)
      // 矩形が重なったときに輪郭線ではなく「隙間」で分離する: サーフェス色で縁取ってから塗る
      if (ringWidth > 0) {
        ctx.lineWidth = ringWidth
        ctx.strokeStyle = SURFACE
        ctx.setLineDash([])
        ctx.stroke()
      }

      if (mark === 'missed') {
        // 「無い」ことを穴で表す。塗らず破線の枠線だけ
        ctx.strokeStyle = CRITICAL
        ctx.lineWidth = 1.2
        ctx.setLineDash([2.5, 2])
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        if (mark === 'match') {
          // 「正常」は目立たせない。目線は間違いのほうへ行くべき
          ctx.globalAlpha = 0.45
          ctx.fillStyle = SERIES_1
        } else if (mark === 'pitchMismatch') {
          ctx.globalAlpha = 1
          ctx.fillStyle = CRITICAL
        } else if (mark === 'extra') {
          ctx.globalAlpha = 1
          ctx.fillStyle = AMBER_CHART
        } else {
          ctx.globalAlpha = 0.85
          ctx.fillStyle = SERIES_1
        }
        ctx.fill()

        if (mark === 'extra') {
          // 赤との色差だけでは第2色覚で区別できないので45°のハッチを重ねる
          ctx.save()
          ctx.clip()
          ctx.globalAlpha = 0.75
          ctx.strokeStyle = SURFACE
          ctx.lineWidth = 1
          ctx.beginPath()
          for (let d = -r.h; d < r.w; d += 4) {
            ctx.moveTo(r.x + d, r.y + r.h)
            ctx.lineTo(r.x + d + r.h, r.y)
          }
          ctx.stroke()
          ctx.restore()
        }
        ctx.globalAlpha = 1
      }

      if (suspect) {
        // 倍音候補は点線の縁取りを足す。色は増やさず中立のインクにして、
        // マークの色分け(青/赤/アンバー)と競合しないようにする。
        // 帯が数pxしかないので矩形を広げずぴったり重ね、薄めに引かないと点線が矩形を食い潰す
        roundRectPath(ctx, r.x, r.y, r.w, r.h, 2)
        ctx.strokeStyle = TEXT_SECONDARY
        ctx.globalAlpha = 0.55
        ctx.lineWidth = 1
        ctx.setLineDash([1, 2])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }
    }

    // 倍音候補とその基音を結ぶ細い縦線。「平行な帯」が同じ発音に由来することを示す
    if (showHarmonicGuides) {
      ctx.strokeStyle = BASELINE
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.4 // 本数が多くなるので、あくまで背景の手掛かりに留める
      ctx.beginPath()
      for (const pair of suspects) {
        const a = notes[pair.suspect]
        const b = notes[pair.fundamental]
        const x = Math.round(xOf(a.startMs)) + 0.5
        const y1 = yOf(a.pitch) + band / 2
        const y2 = yOf(b.pitch) + band / 2
        if (Math.abs(y2 - y1) < 6) continue // 近すぎる線は情報にならず汚れるだけ
        ctx.moveTo(x, Math.min(y1, y2))
        ctx.lineTo(x, Math.max(y1, y2))
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }, [notes, ghosts, height, pitchRange, showHarmonicGuides, width, suspects, suspectSet])

  function pick(clientX: number, clientY: number) {
    const canvas = canvasRef.current
    if (!canvas) return
    const box = canvas.getBoundingClientRect()
    const px = clientX - box.left
    const py = clientY - box.top
    // 帯は数pxしかないので当たり判定はマークより大きめに取る(特にタッチ)
    const PAD_X = 3
    const PAD_Y = 5
    let found: LaidOutNote | null = null
    let bestDist = Infinity
    for (const r of rectsRef.current) {
      if (px < r.x - PAD_X || px > r.x + r.w + PAD_X) continue
      if (py < r.y - PAD_Y || py > r.y + r.h + PAD_Y) continue
      const dist = Math.abs(py - (r.y + r.h / 2))
      if (dist < bestDist) {
        bestDist = dist
        found = r
      }
    }
    setHover(found)
  }

  // ツールチップの位置。左右にはみ出さないようにクランプする
  const TIP_W = 168
  const tipLeft = hover ? Math.min(Math.max(hover.x + hover.w / 2 - TIP_W / 2, 4), Math.max(4, width - TIP_W - 4)) : 0
  const tipAbove = hover ? hover.y > 46 : true
  const tipTop = hover ? (tipAbove ? hover.y - 42 : hover.y + hover.h + 6) : 0

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, display: 'block', touchAction: 'pan-y' }}
        // hover非対応端末(Android Chrome)でもタップで同じ情報が出るようにpointerイベントで扱う
        onPointerMove={(e) => pick(e.clientX, e.clientY)}
        onPointerDown={(e) => pick(e.clientX, e.clientY)}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      />
      {hover && (
        <div
          style={{
            position: 'absolute',
            left: tipLeft,
            top: tipTop,
            width: TIP_W,
            padding: '5px 8px',
            borderRadius: 8,
            background: SURFACE,
            border: `1px solid ${BASELINE}`,
            boxShadow: '0 2px 8px rgba(11,11,11,0.12)',
            font: FONT,
            color: TEXT_SECONDARY,
            lineHeight: 1.45,
            pointerEvents: 'none', // ツールチップ自身がpointerleaveを誘発しないように
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {pitchToName(hover.note.pitch)} · {MARK_LABEL[hover.note.mark ?? 'plain']}
          </div>
          <div>
            {(hover.note.startMs / 1000).toFixed(2)}s から {Math.round(hover.note.durationMs)}ms
          </div>
          {hover.suspect && <div>倍音由来の誤検出候補</div>}
        </div>
      )}
      {showLegend && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 12px',
            marginTop: 6,
            fontSize: 11,
            // 凡例のテキストはインク色。マークの色を文字に使うと、色覚特性によっては読めなくなる
            color: TEXT_SECONDARY,
          }}
        >
          {MARK_ORDER.filter((m) => usedMarks.has(m)).map((m) => (
            <span key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <LegendSwatch mark={m} />
              {MARK_LABEL[m]}
            </span>
          ))}
          {showHarmonicGuides && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span
                style={{
                  width: 12,
                  height: 10,
                  borderRadius: 2,
                  border: `1px dotted ${TEXT_SECONDARY}`,
                  display: 'inline-block',
                }}
              />
              倍音由来の誤検出候補 {suspectSet.size}音
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** 凡例の四角。色だけでなくCanvas側と同じ「塗り/控えめな塗り/中空/ハッチ」を再現する */
function LegendSwatch({ mark }: { mark: PianoRollMark }) {
  const base: React.CSSProperties = { width: 12, height: 10, borderRadius: 2, display: 'inline-block' }
  if (mark === 'missed') {
    return <span style={{ ...base, border: `1.5px dashed ${CRITICAL}` }} />
  }
  if (mark === 'extra') {
    return (
      <span
        style={{
          ...base,
          backgroundColor: AMBER_CHART,
          backgroundImage: `repeating-linear-gradient(45deg, ${SURFACE} 0 1px, transparent 1px 3.5px)`,
        }}
      />
    )
  }
  if (mark === 'pitchMismatch') return <span style={{ ...base, backgroundColor: CRITICAL }} />
  return <span style={{ ...base, backgroundColor: SERIES_1, opacity: mark === 'match' ? 0.45 : 0.85 }} />
}
