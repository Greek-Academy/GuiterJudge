import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Thread } from '../db'
import { convertMusicXml, sliceMeasures, retime, type ParsedScore, type ScoreConversion } from '../score'
import { setReferenceTakeFromScore, tuningLowestForScore, type ScoreReferenceResult } from '../actions'
import { playNoteEvents } from '../preview'
import { synthesizeTake } from '../synth'
import { pitchToName } from '../pitchNames'

// 楽譜ファイル(MusicXML / .mxl)からお手本を作る取り込みパネル(DesignDoc Appendix C 入口D)。
// ThreadDetail の「お手本(任意)」節の中にインラインで出す(モーダル・ルーターは使わない方針)。
// パース(parseScoreFile)は呼び出し側で済ませ、ここでは変換条件(反復・装飾音・小節範囲・BPM)を選ばせる。

/** 比較側のテンポ事前正規化(comparison.ts)が吸収できる倍率の上限 */
const TEMPO_RATIO_LIMIT = 2.5
/** これより長い範囲なら「数小節に絞ると比較が安定」の注記を出す */
const LONG_RANGE_MEASURES = 16
const BPM_MIN = 20
const BPM_MAX = 300
/** 大半の楽譜で出るので、info 扱いで畳んでおく警告 */
const QUIET_CODES = new Set(['fast-notes', 'chord-heavy'])
/**
 * 試聴は保存されるのと同じ合成音(synthesizeTake の WAV)で鳴らす。合成は同期処理で、
 * デスクトップで 256 秒分 60 ms 程度だがスマホでは数倍かかるので、これより長い範囲は発振器の簡易プレビューにする
 */
const SYNTH_PREVIEW_MAX_MS = 180_000

/** synth = 合成中、audio = 合成音を再生中(止められる)、osc = 発振器の簡易プレビュー中(止められない) */
type PreviewState = 'idle' | 'synth' | 'audio' | 'osc'

type Props = {
  thread: Thread
  parsed: ParsedScore
  onDone: (result: ScoreReferenceResult, conv: ScoreConversion) => void
  onCancel: () => void
  onError: (message: string) => void
}

function measureLabel(m: { number: string; pass: number }): string {
  return `第 ${m.number} 小節${m.pass > 1 ? `(${m.pass} 回目)` : ''}`
}

/** 上限をわずかに超えた倍率(2.51 など)を「2.5 倍」と出すと上限と同じに見えるので、そのときだけ小数 2 桁にする */
function fmtRatio(r: number): string {
  return r.toFixed(1) === TEMPO_RATIO_LIMIT.toFixed(1) ? r.toFixed(2) : r.toFixed(1)
}

function fmtBpm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

export default function ScoreImportPanel({ thread, parsed, onDone, onCancel, onError }: Props) {
  const [expandRepeats, setExpandRepeats] = useState(true)
  const [keepGrace, setKeepGrace] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<PreviewState>('idle')
  // 合成した WAV の再生。範囲・BPM が変わらなければ合成し直さない
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const synthCache = useRef<{ notes: ScoreConversion['notes']; url: string } | null>(null)
  const ids = useId()
  useEffect(
    () => () => {
      audioRef.current?.pause()
      if (synthCache.current) URL.revokeObjectURL(synthCache.current.url)
    },
    [],
  )

  // 楽譜テンポで一度展開したもの。小節一覧・楽譜テンポ・no-tempo の判定はこれを見る
  const base = useMemo<{ conv: ScoreConversion | null; error: string | null }>(() => {
    try {
      return { conv: convertMusicXml(parsed.xml, { expandRepeats, grace: keepGrace ? 'keep' : 'drop' }), error: null }
    } catch (e) {
      return { conv: null, error: (e as Error).message }
    }
  }, [parsed, expandRepeats, keepGrace])
  const conv0 = base.conv
  const noTempo = conv0?.tempoSource === 'default'
  const measureCount = conv0?.measures.length ?? 0

  // 小節範囲(conv.measures のインデックス)。反復展開を切り替えると演奏小節列が変わるので全体に戻す
  const [range, setRange] = useState<[number, number]>(() => [0, Math.max(0, measureCount - 1)])
  useEffect(() => {
    setRange([0, Math.max(0, measureCount - 1)])
  }, [measureCount])
  const from = Math.min(range[0], Math.max(0, measureCount - 1))
  const to = Math.max(from, Math.min(range[1], Math.max(0, measureCount - 1)))
  const isWhole = from === 0 && to === measureCount - 1

  // BPM。既定はスレッドのメトロノーム → 楽譜テンポ。楽譜にテンポが無くメトロノームも無ければ空(入力必須)
  const defaultBpm = thread.metronome?.bpm ?? (conv0 && !noTempo ? Math.round(conv0.tempoBpm) : undefined)
  const [bpmText, setBpmText] = useState<string>(defaultBpm !== undefined ? String(defaultBpm) : '')
  const bpm = Number(bpmText)
  const bpmValid = bpmText.trim() !== '' && Number.isFinite(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX

  // 選んだ範囲(楽譜テンポのまま)→ 指定 BPM で展開し直したもの
  const sliced = useMemo(() => (conv0 && !isWhole ? sliceMeasures(conv0, from, to) : conv0), [conv0, isWhole, from, to])
  // 楽譜テンポのまま弾くなら retime しない(途中のテンポ変化を平らにしないため)
  const final = useMemo<ScoreConversion | null>(() => {
    if (!sliced || !bpmValid) return sliced
    if (!noTempo && Math.abs(bpm - sliced.tempoBpm) < 0.05) return sliced
    return retime(sliced, bpm)
  }, [sliced, bpmValid, bpm, noTempo])

  if (!conv0 || !final) {
    return (
      <div className="metro-panel score-import">
        <div className="notice error" style={{ margin: 0 }}>
          楽譜を読み込めませんでした: {base.error}
        </div>
        <button className="secondary" onClick={onCancel}>
          閉じる
        </button>
      </div>
    )
  }

  const stats = conv0.stats
  const selStats = final.stats
  // 範囲の先頭で有効な楽譜テンポ(途中でテンポが変わる曲では全体の先頭と違う)
  const scoreTempo = noTempo ? null : (sliced ?? conv0).tempoBpm
  const tempoRatio = scoreTempo && bpmValid ? Math.max(bpm / scoreTempo, scoreTempo / bpm) : 1
  const selectedMeasures = to - from + 1
  const warnList = final.warnings.filter((w) => w.level === 'warn' && w.code !== 'no-tempo' && !QUIET_CODES.has(w.code))
  const infoList = final.warnings.filter((w) => w.level === 'info' || QUIET_CODES.has(w.code))
  const lowest = selStats.pitchRange?.[0]
  const currentLowest = thread.tuningLowest ?? 40
  const willLowerTo = lowest !== undefined && lowest < currentLowest ? tuningLowestForScore(lowest) : undefined
  // variant-tuning の文面は「取り込むと最低音を下げます」。スレッドがすでにそこまで下がっていれば当てはまらないので、
  // 警告から外して「そのまま取り込む」旨だけを info 側に出す
  const tuningAlreadyLow = lowest !== undefined && lowest < 40 && willLowerTo === undefined
  const warnShown = tuningAlreadyLow ? warnList.filter((w) => w.code !== 'variant-tuning') : warnList
  const chosenParts = conv0.parts.filter((p) => p.chosen).map((p) => p.partName || p.key)
  const canSubmit = !busy && bpmValid && final.notes.length > 0
  const useSynthPreview = selStats.durationMs <= SYNTH_PREVIEW_MAX_MS
  // ボタンが押せない理由(画面に出し、aria-describedby でボタンにも結び付ける)
  const blockReason = busy
    ? null
    : final.notes.length === 0
      ? '選んだ範囲に音符が無いので、試聴もお手本にもできません。範囲を広げてください。'
      : !bpmValid
        ? bpmText.trim() === ''
          ? '弾く BPM を入れると「お手本にする」を押せます。'
          : `BPM を ${BPM_MIN}〜${BPM_MAX} で入れると「お手本にする」を押せます。`
        : null

  function stopPreview() {
    audioRef.current?.pause()
    audioRef.current = null
    setPreview('idle')
  }

  async function handlePreview() {
    if (!final) return
    if (preview === 'audio') return stopPreview()
    if (preview !== 'idle') return
    if (!useSynthPreview) {
      setPreview('osc')
      try {
        await playNoteEvents(final.notes, { raw: true })
      } finally {
        setPreview('idle')
      }
      return
    }
    try {
      let url = synthCache.current?.notes === final.notes ? synthCache.current.url : null
      if (!url) {
        setPreview('synth')
        // 「合成中…」を描画させてから同期の合成に入る
        await new Promise((r) => setTimeout(r, 30))
        const blob = synthesizeTake(final.notes)
        if (synthCache.current) URL.revokeObjectURL(synthCache.current.url)
        url = URL.createObjectURL(blob)
        synthCache.current = { notes: final.notes, url }
      }
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        if (audioRef.current === audio) stopPreview()
      }
      setPreview('audio')
      await audio.play()
    } catch (e) {
      stopPreview()
      onError('試聴を再生できませんでした: ' + (e as Error).message)
    }
  }

  async function handleSubmit() {
    if (!final || !conv0) return
    setBusy(true)
    try {
      const result = await setReferenceTakeFromScore(thread.id, final, {
        fileName: parsed.fileName,
        measureFrom: isWhole ? undefined : conv0.measures[from].number,
        measureTo: isWhole ? undefined : conv0.measures[to].number,
      })
      onDone(result, final)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="metro-panel score-import">
      <div>
        <div className="title">{stats.title || parsed.fileName}</div>
        <div className="meta" style={{ marginTop: 2 }}>
          {parsed.fileName}
          {stats.software ? ` / ${stats.software}` : ''}
          {chosenParts.length ? ` / ${chosenParts.join('・')}` : ''}
        </div>
      </div>

      <div className="score-summary">
        <div>
          <span className="k">小節</span>
          {stats.measureCount}
          {stats.hasRepeats && stats.repeatsExpanded ? `(反復展開で ${stats.playedMeasureCount})` : ''}
        </div>
        <div>
          <span className="k">音数</span>
          {selStats.noteCount}
          {!isWhole ? ` / 全体 ${stats.noteCount}` : ''}
        </div>
        <div>
          <span className="k">和音率</span>
          {Math.round(selStats.chordRatio * 100)}%
        </div>
        <div>
          <span className="k">音域</span>
          {selStats.pitchRange ? `${pitchToName(selStats.pitchRange[0])}〜${pitchToName(selStats.pitchRange[1])}` : '—'}
        </div>
        <div>
          <span className="k">楽譜テンポ</span>
          {scoreTempo ? `♩=${fmtBpm(Math.round(scoreTempo * 10) / 10)}` : 'なし'}
        </div>
        <div>
          <span className="k">長さ</span>
          {(selStats.durationMs / 1000).toFixed(1)}秒
        </div>
      </div>

      {warnShown.length > 0 && (
        <ul className="score-warn" aria-label="取り込みの注意">
          {warnShown.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}
      {(infoList.length > 0 || tuningAlreadyLow) && (
        <details className="score-info">
          <summary>ほかの注意({infoList.length + (tuningAlreadyLow ? 1 : 0)})</summary>
          <ul>
            {tuningAlreadyLow && (
              <li>
                標準調弦より低い音(最低 {pitchToName(lowest!)})がありますが、このスレッドの最低音はすでに {pitchToName(currentLowest)}{' '}
                なのでそのまま取り込みます。
              </li>
            )}
            {infoList.map((w) => (
              <li key={w.code}>{w.message}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="row metro-row" role="group" aria-labelledby={`${ids}-range`}>
        <span className="lbl" id={`${ids}-range`}>
          小節範囲
        </span>
        <select aria-label="開始小節" value={from} disabled={busy} onChange={(e) => setRange([Number(e.target.value), Math.max(Number(e.target.value), to)])}>
          {conv0.measures.map((m, i) => (
            <option key={i} value={i}>
              {measureLabel(m)}
            </option>
          ))}
        </select>
        <span aria-hidden="true">〜</span>
        <select aria-label="終了小節" value={to} disabled={busy} onChange={(e) => setRange([Math.min(from, Number(e.target.value)), Number(e.target.value)])}>
          {conv0.measures.map((m, i) => (
            <option key={i} value={i} disabled={i < from}>
              {measureLabel(m)}
            </option>
          ))}
        </select>
      </div>
      {selectedMeasures > LONG_RANGE_MEASURES && (
        <div className="meta" style={{ margin: 0 }} role="note">
          いま {selectedMeasures} 小節分です。練習しているフレーズの数小節に絞ると比較が安定します。
        </div>
      )}

      <div className="row metro-row">
        <label className="lbl" htmlFor={`${ids}-bpm`}>
          <span aria-hidden="true">♩=</span>
          <span className="score-sr">弾く BPM(四分音符)</span>
        </label>
        <input
          id={`${ids}-bpm`}
          type="number"
          inputMode="decimal"
          min={BPM_MIN}
          max={BPM_MAX}
          value={bpmText}
          placeholder={noTempo ? '必須' : undefined}
          required={noTempo}
          aria-invalid={bpmText.trim() !== '' && !bpmValid}
          aria-describedby={[`${ids}-bpm-hint`, bpmText.trim() !== '' && !bpmValid ? `${ids}-bpm-err` : '', tempoRatio > TEMPO_RATIO_LIMIT ? `${ids}-bpm-ratio` : '']
            .filter(Boolean)
            .join(' ')}
          disabled={busy}
          onChange={(e) => setBpmText(e.target.value)}
        />
        <span className="meta" id={`${ids}-bpm-hint`} style={{ margin: 0, flex: 1 }}>
          {noTempo ? '楽譜にテンポが無いので、弾く BPM を入れてください' : '弾く BPM(比較側でもテンポ差は補正します)'}
        </span>
      </div>
      {bpmText.trim() !== '' && !bpmValid && (
        <div className="score-warn-line" id={`${ids}-bpm-err`} role="alert">
          BPM は {BPM_MIN}〜{BPM_MAX} で入れてください。</div>
      )}
      {tempoRatio > TEMPO_RATIO_LIMIT && (
        <div className="score-warn-line" id={`${ids}-bpm-ratio`} role="status">
          楽譜のテンポ(♩={fmtBpm(Math.round(scoreTempo! * 10) / 10)})と {fmtRatio(tempoRatio)} 倍違います。拍の単位(2分・付点4分など)の取り違えがないか確かめてください。
          比較側で補正できるテンポ差は {TEMPO_RATIO_LIMIT} 倍までです。
        </div>
      )}

      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={expandRepeats} disabled={busy} onChange={(e) => setExpandRepeats(e.target.checked)} />
        <span style={{ flex: 1 }}>反復記号・括弧を展開する{stats.hasRepeats ? '' : '(この楽譜には反復なし)'}</span>
      </label>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={keepGrace} disabled={busy} onChange={(e) => setKeepGrace(e.target.checked)} />
        <span style={{ flex: 1 }}>装飾音を含める{stats.graceNotes ? `(${stats.graceNotes} 音)` : ''}</span>
      </label>

      <div className="row" style={{ gap: 8 }}>
        <button
          className="secondary"
          onClick={() => void handlePreview()}
          disabled={preview === 'synth' || preview === 'osc' || final.notes.length === 0}
          aria-describedby={`${ids}-preview-note${blockReason && final.notes.length === 0 ? ` ${ids}-why` : ''}`}
        >
          {preview === 'synth' ? '合成中…' : preview === 'audio' ? '■ 停止' : preview === 'osc' ? '再生中…' : '▶ 試聴'}
        </button>
        <button
          className="primary"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          aria-describedby={blockReason ? `${ids}-why` : undefined}
        >
          {busy ? '作成中…' : 'お手本にする'}
        </button>
      </div>
      <div className="score-hint" id={`${ids}-preview-note`}>
        {useSynthPreview
          ? '試聴はお手本として保存されるのと同じ合成音です。'
          : `範囲が長い(${Math.round(SYNTH_PREVIEW_MAX_MS / 60000)} 分超)ので、試聴は簡易音で鳴らします(保存されるのは合成音)。`}
      </div>
      {blockReason && (
        <div className="score-why" id={`${ids}-why`} role="status">
          {blockReason}
        </div>
      )}
      <button className="secondary" onClick={onCancel} disabled={busy}>
        キャンセル
      </button>
    </div>
  )
}

/**
 * 保存済みのお手本音声(Take.audioBlob)を再生・停止するボタン。ThreadDetail の「お手本(任意)」行で使う。
 * 楽譜から作ったお手本なら合成音、音声/動画ファイルから作ったお手本なら取り込んだ音声がそのまま鳴る
 */
export function ReferenceAudioButton({ blob, label = '▶ 再生' }: { blob: Blob; label?: string }) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      audioRef.current?.pause()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    },
    [blob],
  )

  function stop() {
    audioRef.current?.pause()
    audioRef.current = null
    setPlaying(false)
  }

  async function toggle() {
    if (playing) return stop()
    if (!urlRef.current) urlRef.current = URL.createObjectURL(blob)
    const audio = new Audio(urlRef.current)
    audioRef.current = audio
    audio.onended = () => {
      if (audioRef.current === audio) stop()
    }
    setPlaying(true)
    try {
      await audio.play()
    } catch {
      stop()
    }
  }

  return (
    <button
      className="secondary"
      style={{ width: 'auto', padding: '4px 10px' }}
      onClick={() => void toggle()}
      aria-label={playing ? 'お手本の音声を止める' : 'お手本の音声を再生する'}
      aria-pressed={playing}
    >
      {playing ? '■ 停止' : label}
    </button>
  )
}
