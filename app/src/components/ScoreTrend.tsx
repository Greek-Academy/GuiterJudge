import { useLayoutEffect, useMemo, useRef, useState } from 'react'

export type ScoreTrendPoint = {
  at: number          // 記録時刻(epoch ms)
  score: number       // 0-100
  /** 点に添える短いラベル（省略可） */
  label?: string
}

export type ScoreTrendProps = {
  points: ScoreTrendPoint[]   // 時系列昇順で渡される前提だが、内部でも念のため昇順に整えること
  /** 描画高さ(px)。既定 160 */
  height?: number
  /** 強調表示したい点のインデックス（今見ているテイクなど） */
  highlightIndex?: number
  /** 点をクリックしたときに呼ばれる */
  onSelect?: (index: number) => void
}

// --- デザイントークン -------------------------------------------------------
// src/App.css の :root で定義している CSS 変数と同じ値をリテラルで持っている。
// SVG の presentation attribute(fill / stroke)に var() を書くと効かない環境があるため、
// あえて二重管理にしている。App.css を変えたらここも合わせて直すこと。
const INK_PRIMARY = '#0b0b0b' // --text-primary
const INK_SECONDARY = '#52514e' // --text-secondary
const INK_MUTED = '#898781' // --text-muted
const SURFACE = '#fcfcfb' // --surface-1
const GRIDLINE = '#e1e0d9' // --gridline
const BASELINE = '#c3c2b7' // --baseline
const SERIES = '#2a78d6' // --series-1
const INK_SUCCESS = '#006300' // --success-text
const INK_CRITICAL = '#d03b3b' // --status-critical

// --- レイアウト定数 ---------------------------------------------------------
const PAD_LEFT = 30 // 0/50/100 の目盛りラベル(11px)がちょうど収まる幅
const PAD_RIGHT = 12
const PAD_TOP = 18 // 一番上の点に付く値ラベルが SVG の外に出ないための余白
const PAD_BOTTOM = 22 // 日付ラベルの帯。ここを削ると軸ラベルだけはみ出す
const FALLBACK_WIDTH = 380 // .phone は 420px 固定で左右 16px の余白が付くので実質この幅
const MARKER_R = 4 // 直径 8px。これ以上小さくすると線と区別が付かない
const LABEL_CHAR_W = 7 // 12px セミボールドの数字 1 文字の概算幅(ラベル衝突判定用)
// 点の間隔がこれより狭いと、マーカーとサーフェスリング(直径12px)が折れ線を食い潰して
// 線が破線のように見えてしまう。破線は「予測値」と誤読されるので、
// 混んできたら中間のマーカーを省いて線の連続性を優先する。
const MARKER_MIN_GAP = 24

// 傾向判定のパラメータ。
// 安定度スコアは録音環境(マイク位置・部屋鳴り)だけで数ポイント揺れるので、
// この幅未満の差は「変化あり」と言い切らずに横ばい扱いにする。
const FLAT_THRESHOLD = 3
// 2 点だと前半・後半の平均が単なる 1 点対 1 点になり、ノイズがそのまま判定になってしまう
const MIN_POINTS_FOR_TREND = 3

type Anchor = 'start' | 'middle' | 'end'
type Side = 'above' | 'below'
type PlacedLabel = { x: number; y: number; anchor: Anchor; side: Side; w: number }

function clampScore(v: number) {
  // 呼び出し側の計算ミスや NaN で描画が壊れないように、必ず 0-100 に丸める
  if (!Number.isFinite(v)) return 0
  return Math.min(100, Math.max(0, v))
}

function mdText(at: number) {
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function dateTimeText(at: number) {
  return new Date(at).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function average(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length
}

// 「直近◯◯で」の部分。日数そのものを出すと 37 日などと細かすぎて読みにくいので、
// スケールに応じて日→週→月へ丸める。
function periodText(fromAt: number, toAt: number) {
  const days = (toAt - fromAt) / 86_400_000
  if (!Number.isFinite(days) || days < 2) return '直近の記録では'
  if (days < 14) return `直近${Math.round(days)}日で`
  if (days < 60) return `直近およそ${Math.round(days / 7)}週間で`
  return `直近およそ${Math.round(days / 30)}か月で`
}

/**
 * 前半の平均と後半の平均を比べるだけの素朴な判定。
 * 回帰直線などでも良いが「なぜその判定になったか」を口頭で説明できることを優先した。
 * 奇数個のときは真ん中の 1 点を捨てて前後を同数にする(前半が 1 点多いと偏るため)。
 *
 * 文言について: このスコアは前のテイクとのばらつきの少なさ(一貫性)であって
 * 音楽的な正しさではない(PRD の Risks)。「上手くなっている」と断定せず
 * 「安定してきています」までに留めること。
 */
function summarizeTrend(scores: number[], fromAt: number, toAt: number) {
  if (scores.length < MIN_POINTS_FOR_TREND) {
    return { text: `記録が${MIN_POINTS_FOR_TREND}回に満たないため、まだ傾向は判断できません`, color: INK_MUTED }
  }
  const half = Math.floor(scores.length / 2)
  const delta = Math.round(average(scores.slice(scores.length - half)) - average(scores.slice(0, half)))
  const period = periodText(fromAt, toAt)
  if (Math.abs(delta) < FLAT_THRESHOLD) {
    return { text: `${period}ほぼ横ばいです`, color: INK_SECONDARY }
  }
  if (delta > 0) {
    return { text: `${period}${delta}ポイント上昇 — 演奏が安定してきています`, color: INK_SUCCESS }
  }
  return { text: `${period}${Math.abs(delta)}ポイント低下 — ばらつきが増えているようです`, color: INK_CRITICAL }
}

// 値ラベルを点の上下どちらかに置く。上下とも入らないことはないが、
// 上端・下端に貼り付いた点では反対側に逃がして SVG の外に出さない。
function placeValueLabel(
  cx: number,
  cy: number,
  text: string,
  width: number,
  height: number,
  prefer?: Side,
): PlacedLabel {
  const w = text.length * LABEL_CHAR_W
  const fitsAbove = cy >= 22
  const fitsBelow = cy <= height - PAD_BOTTOM - 13
  let side: Side = fitsAbove ? 'above' : 'below'
  if (prefer === 'above' && fitsAbove) side = 'above'
  if (prefer === 'below' && fitsBelow) side = 'below'
  const y = side === 'above' ? cy - 11 : cy + 19

  // 右端の点は middle のままだと右にはみ出すので end 寄せにして左へ伸ばす。左端はその逆。
  let anchor: Anchor = 'middle'
  if (cx + w / 2 > width - 4) anchor = 'end'
  else if (cx - w / 2 < PAD_LEFT) anchor = 'start'
  return { x: cx, y, anchor, side, w }
}

function labelSpan(l: PlacedLabel): [number, number] {
  if (l.anchor === 'end') return [l.x - l.w, l.x]
  if (l.anchor === 'start') return [l.x, l.x + l.w]
  return [l.x - l.w / 2, l.x + l.w / 2]
}

function labelsCollide(a: PlacedLabel, b: PlacedLabel) {
  if (Math.abs(a.y - b.y) >= 14) return false
  const [a0, a1] = labelSpan(a)
  const [b0, b1] = labelSpan(b)
  return a0 - 6 < b1 && b0 - 6 < a1
}

export default function ScoreTrend({ points, height = 160, highlightIndex, onSelect }: ScoreTrendProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const [activePos, setActivePos] = useState<number | null>(null)
  const [tipH, setTipH] = useState(0)

  // viewBox で引き伸ばすと文字まで一緒に拡大されて字形が歪むので、
  // 親の実寸を測って SVG 座標 1 = 1px で描く。
  // useLayoutEffect にしているのは、フォールバック幅のまま 1 フレーム描いて
  // 親からはみ出すのを避けるため。
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setWidth(Math.max(220, el.clientWidth))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ツールチップの高さはラベルの折り返し次第で変わるので、実測してから縦位置を決める。
  // useLayoutEffect なので、ずれた位置で 1 フレーム描かれることはない。
  useLayoutEffect(() => {
    setTipH(tipRef.current?.offsetHeight ?? 0)
  }, [activePos, width])

  // 呼び出し側は昇順で渡す前提だが、念のため内部でも並べ直す。
  // ただし highlightIndex と onSelect は「呼び出し側が渡した配列の添字」で会話したいので、
  // 元の添字を持ち回って変換する。
  const series = useMemo(
    () =>
      points
        .map((p, originalIndex) => ({ ...p, originalIndex }))
        .sort((a, b) => a.at - b.at || a.originalIndex - b.originalIndex),
    [points],
  )

  const n = series.length
  const summary = useMemo(
    () => summarizeTrend(series.map((p) => clampScore(p.score)), series[0]?.at ?? 0, series[n - 1]?.at ?? 0),
    [series, n],
  )
  const highlightPos = useMemo(() => {
    if (highlightIndex === undefined) return -1
    return series.findIndex((p) => p.originalIndex === highlightIndex)
  }, [series, highlightIndex])

  const wrapStyle = { position: 'relative' as const, width: '100%' }
  const titleStyle = { fontSize: 12, fontWeight: 600, color: INK_SECONDARY, marginBottom: 4 }
  const noteStyle = { fontSize: 11, color: INK_MUTED, lineHeight: 1.5, marginTop: 6 }

  if (n === 0) {
    return (
      <div ref={wrapRef} style={wrapStyle}>
        <div style={titleStyle}>安定度スコアの推移</div>
        <div style={{ fontSize: 12, color: INK_MUTED, padding: '12px 0' }}>
          まだ記録がありません。録音すると、ここに推移が表示されます。
        </div>
      </div>
    )
  }

  const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT)
  const plotH = Math.max(1, height - PAD_TOP - PAD_BOTTOM)
  const plotBottom = PAD_TOP + plotH
  // 横軸は「テイクの順番」で等間隔にしている。実時間に比例させると、
  // 同じ日に何本も録ったテイクが右端で団子になり 8px のマーカーが重なって読めなくなるため。
  // 期間そのものは両端の日付ラベルと要約文が伝える。
  const xAt = (i: number) => (n <= 1 ? PAD_LEFT + plotW / 2 : PAD_LEFT + (plotW * i) / (n - 1))
  // 縦軸は 0-100 固定。データの最小〜最大に自動フィットさせると
  // 数ポイントの揺れが劇的な改善に見えてしまい、誤解を招く。
  const yAt = (score: number) => PAD_TOP + plotH * (1 - clampScore(score) / 100)

  const coords = series.map((p, i) => ({ x: xAt(i), y: yAt(p.score) }))
  const showAllMarkers = n <= 1 || plotW / (n - 1) >= MARKER_MIN_GAP
  const active = activePos !== null && activePos < n ? activePos : null

  // 直接ラベルは「最新の点」と「highlightIndex の点」だけ。全点に数字を振ると読まれない。
  const lastIdx = n - 1
  const lastLabel = placeValueLabel(
    coords[lastIdx].x,
    coords[lastIdx].y,
    String(Math.round(clampScore(series[lastIdx].score))),
    width,
    height,
  )
  let hlLabel: PlacedLabel | null = null
  const hlText = highlightPos >= 0 ? String(Math.round(clampScore(series[highlightPos].score))) : ''
  if (highlightPos >= 0 && highlightPos !== lastIdx) {
    let candidate = placeValueLabel(coords[highlightPos].x, coords[highlightPos].y, hlText, width, height)
    if (labelsCollide(candidate, lastLabel)) {
      // まず上下の逆側へ逃がす
      const flipped = placeValueLabel(
        coords[highlightPos].x,
        coords[highlightPos].y,
        hlText,
        width,
        height,
        lastLabel.side === 'above' ? 'below' : 'above',
      )
      if (flipped.side !== lastLabel.side) {
        candidate = flipped
      } else {
        // 上下とも同じ側にしか置けないときは、最新の点から離れる向きへ水平にずらす
        const goLeft = coords[highlightPos].x < coords[lastIdx].x
        candidate = goLeft
          ? { ...candidate, anchor: 'end', x: Math.max(candidate.x - 6, candidate.w + 2) }
          : { ...candidate, anchor: 'start', x: Math.min(candidate.x + 6, width - 2 - candidate.w) }
      }
    }
    hlLabel = candidate
  }

  // ツールチップは絶対配置の div。SVG の <title> はブラウザ任せで表示が遅く、見た目も揃わない。
  const TIP_W = 160
  const tipPoint = active !== null ? series[active] : null
  const tipLeft = active !== null ? Math.min(Math.max(coords[active].x - TIP_W / 2, 0), Math.max(0, width - TIP_W)) : 0
  // 基本は点の上。上に入らなければ下へ回し、最後に SVG の枠内へ丸める
  let tipTop = 0
  if (active !== null) {
    tipTop = coords[active].y - 14 - tipH
    if (tipTop < 0) tipTop = coords[active].y + 14
    tipTop = Math.min(Math.max(tipTop, 0), Math.max(0, height - tipH))
  }

  function bandX(i: number) {
    const left = i === 0 ? PAD_LEFT : (coords[i - 1].x + coords[i].x) / 2
    const right = i === n - 1 ? width - PAD_RIGHT : (coords[i].x + coords[i + 1].x) / 2
    return { left, right: Math.max(right, left + 1) }
  }

  return (
    <div ref={wrapRef} style={wrapStyle}>
      {/* 系列は 1 本だけなので凡例は出さない。このタイトルが系列名を兼ねる。 */}
      <div style={titleStyle}>安定度スコアの推移</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: summary.color, marginBottom: 6, lineHeight: 1.4 }}>
        {summary.text}
      </div>

      {/* ツールチップの座標は SVG の左上を原点にしたいので、SVG と同じ入れ物に入れる。
          外側の div を基準にするとタイトルと要約文の高さぶんだけ上にずれる。 */}
      <div style={{ position: 'relative' }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`安定度スコアの推移。${n}件の記録。${summary.text}`}
          style={{ display: 'block', fontFamily: 'inherit', touchAction: 'pan-y' }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setActivePos(null)
          }}
        >
          {/* 目盛りは 0/50/100 の 3 本だけ。実線のヘアライン(破線は閾値や予測値と誤読される) */}
          {[0, 50, 100].map((v) => (
            <g key={v}>
              <line
                x1={PAD_LEFT}
                y1={yAt(v)}
                x2={width - PAD_RIGHT}
                y2={yAt(v)}
                stroke={v === 0 ? BASELINE : GRIDLINE}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text x={PAD_LEFT - 6} y={yAt(v)} dy="0.32em" textAnchor="end" fontSize={11} fill={INK_MUTED}>
                {v}
              </text>
            </g>
          ))}

          {/* 注目中の点の位置を示す縦のヘアライン。ホバー用の線より弱い色にして役割を分ける */}
          {highlightPos >= 0 && (
            <line
              x1={coords[highlightPos].x}
              y1={PAD_TOP}
              x2={coords[highlightPos].x}
              y2={plotBottom}
              stroke={GRIDLINE}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          )}
          {active !== null && (
            <line
              x1={coords[active].x}
              y1={PAD_TOP}
              x2={coords[active].x}
              y2={plotBottom}
              stroke={BASELINE}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          )}

          {/* 点が 1 個のときは折れ線が引けないので、マーカーと値だけを出す */}
          {n >= 2 && (
            <polyline
              points={coords.map((c) => `${c.x},${c.y}`).join(' ')}
              fill="none"
              stroke={SERIES}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* マーカーはサーフェス色の 2px リングで縁取り、線と重なっても分離して見えるようにする。
              点が混んでいるときは両端・注目点・ホバー中の点だけに絞る(値はツールチップで読める) */}
          {coords.map((c, i) =>
            showAllMarkers || i === 0 || i === lastIdx || i === highlightPos || i === active ? (
              <circle
                key={series[i].originalIndex}
                cx={c.x}
                cy={c.y}
                r={i === highlightPos ? MARKER_R + 1.5 : MARKER_R}
                fill={SERIES}
                stroke={SURFACE}
                strokeWidth={2}
              />
            ) : null,
          )}
          {highlightPos >= 0 && (
            <circle
              cx={coords[highlightPos].x}
              cy={coords[highlightPos].y}
              r={7.5}
              fill="none"
              stroke={SERIES}
              strokeWidth={1.5}
            />
          )}
          {active !== null && (
            <circle cx={coords[active].x} cy={coords[active].y} r={7.5} fill="none" stroke={BASELINE} strokeWidth={1.5} />
          )}

          {/* 値ラベル。テキストには系列色を使わず、主/副のインクを使う */}
          <text
            x={lastLabel.x}
            y={lastLabel.y}
            textAnchor={lastLabel.anchor}
            fontSize={12}
            fontWeight={600}
            fill={INK_PRIMARY}
          >
            {Math.round(clampScore(series[lastIdx].score))}
          </text>
          {hlLabel && (
            <text x={hlLabel.x} y={hlLabel.y} textAnchor={hlLabel.anchor} fontSize={12} fontWeight={600} fill={INK_SECONDARY}>
              {hlText}
            </text>
          )}

          {/* 日付は全部は出さない。最初と最後だけ M/D */}
          {n === 1 ? (
            <text x={coords[0].x} y={height - 5} textAnchor="middle" fontSize={11} fill={INK_MUTED}>
              {mdText(series[0].at)}
            </text>
          ) : (
            <>
              <text x={PAD_LEFT} y={height - 5} textAnchor="start" fontSize={11} fill={INK_MUTED}>
                {mdText(series[0].at)}
              </text>
              <text x={width - PAD_RIGHT} y={height - 5} textAnchor="end" fontSize={11} fill={INK_MUTED}>
                {mdText(series[lastIdx].at)}
              </text>
            </>
          )}

          {/* 当たり判定。マーカーそのものは 8px しかなく指では狙えないので、
              点ごとにプロット全高の透明な帯を重ねて「その列のどこでも」反応するようにしている */}
          {coords.map((_, i) => {
            const band = bandX(i)
            const p = series[i]
            return (
              <rect
                key={`hit-${p.originalIndex}`}
                x={band.left}
                y={PAD_TOP}
                width={band.right - band.left}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role={onSelect ? 'button' : 'img'}
                aria-label={`${dateTimeText(p.at)} 安定度${Math.round(clampScore(p.score))}${p.label ? ` ${p.label}` : ''}`}
                style={{ cursor: onSelect ? 'pointer' : 'default', outline: 'none' }}
                onPointerEnter={(e) => {
                  if (e.pointerType === 'mouse') setActivePos(i)
                }}
                onPointerDown={() => setActivePos(i)}
                onFocus={() => setActivePos(i)}
                onBlur={() => setActivePos(null)}
                onClick={() => onSelect?.(p.originalIndex)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect?.(p.originalIndex)
                  }
                }}
              />
            )
          })}
        </svg>

        {tipPoint && (
          <div
            ref={tipRef}
            style={{
              position: 'absolute',
              left: tipLeft,
              top: tipTop,
              width: TIP_W,
              background: SURFACE,
              border: `1px solid ${GRIDLINE}`,
              borderRadius: 10,
              padding: '7px 9px',
              boxShadow: '0 2px 8px rgba(11,11,11,0.08)',
              pointerEvents: 'none', // ツールチップ自身が当たり判定を奪ってちらつくのを防ぐ
              zIndex: 1,
            }}
          >
            {/* 読み手は既にどの系列かを知っていて数値が欲しいので、値を先頭・強く出す */}
            <div style={{ fontSize: 16, fontWeight: 600, color: INK_PRIMARY, lineHeight: 1.2 }}>
              {Math.round(clampScore(tipPoint.score))}
              <span style={{ fontSize: 11, fontWeight: 400, color: INK_MUTED }}> / 100</span>
            </div>
            <div style={{ fontSize: 11, color: INK_MUTED, marginTop: 2 }}>{dateTimeText(tipPoint.at)}</div>
            {tipPoint.label && (
              <div style={{ fontSize: 11, color: INK_SECONDARY, marginTop: 2, wordBreak: 'break-word' }}>
                {tipPoint.label}
              </div>
            )}
          </div>
        )}

      </div>

      {/* スコアの意味を取り違えられると診断そのものが誤解されるので、必ず添える */}
      <div style={noteStyle}>安定度は前のテイクとのばらつきの少なさを表す指標で、音楽的な正しさではありません。</div>
    </div>
  )
}
