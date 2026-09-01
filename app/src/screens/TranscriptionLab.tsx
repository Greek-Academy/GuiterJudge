import { useRef, useState } from 'react'
import { Recorder, decodeAudioBlob } from '../recording'
import { preprocessForAnalysis, type PreprocessResult } from '../preprocess'
import {
  runModel,
  notesFromModelOutput,
  preloadModel,
  DEFAULT_ONSET_THRESHOLD,
  DEFAULT_FRAME_THRESHOLD,
  DEFAULT_MIN_NOTE_FRAMES,
  GUITAR_PITCH_RANGE,
  filterByPitchRange,
  type RawModelOutput,
} from '../basicPitch'
import { playNoteEvents } from '../preview'
import { parsePitchList, pitchToName, pitchSequenceDiff, type PitchDiff } from '../pitchNames'
import PianoRoll from '../components/PianoRoll'
import type { NoteEvent } from '../db'

// DesignDoc Section 8 / Appendix B「M1本検証への示唆」に対応する検証用画面。
//   - 実録音をブラウザ上の本番と同じコードパス(preprocess → runModel)に通す
//   - onset/frame閾値のチューニングを実データに対して行う
// 閾値はoutputToNotesPolyの後処理パラメータでしかないため、推論は1回だけ実行し、
// 同じRawModelOutputを使い回してスイープする(再推論不要)。

const ONSET_GRID = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
const FRAME_GRID = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]

type Source = { label: string; buffer: AudioBuffer }

type SweepCell = {
  onset: number
  frame: number
  noteCount: number
  diff: PitchDiff | null
}

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`
}

export default function TranscriptionLab({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState('モデル未読み込み')
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)

  const [source, setSource] = useState<Source | null>(null)
  const [pre, setPre] = useState<Omit<PreprocessResult, 'buffer'> | null>(null)
  const [raw, setRaw] = useState<RawModelOutput | null>(null)
  const [timings, setTimings] = useState<{ modelLoadMs?: number; preprocessMs: number; inferenceMs: number } | null>(null)

  const [onset, setOnset] = useState(DEFAULT_ONSET_THRESHOLD)
  const [frame, setFrame] = useState(DEFAULT_FRAME_THRESHOLD)
  const [minNoteFrames, setMinNoteFrames] = useState(DEFAULT_MIN_NOTE_FRAMES)

  const [applyPitchRange, setApplyPitchRange] = useState(true)
  const [expectedText, setExpectedText] = useState('')
  const [octaveTolerant, setOctaveTolerant] = useState(false)
  const [sweep, setSweep] = useState<SweepCell[] | null>(null)

  const recorderRef = useRef<Recorder | null>(null)

  const expected = parsePitchList(expectedText)
  const range = applyPitchRange ? GUITAR_PITCH_RANGE : null
  // 音域フィルタは閾値処理のさらに後段なので、素の結果を1回求めてから絞る
  // (スライダー操作のたびにnotesFromModelOutputを2回走らせないため)
  const notesBeforeRange: NoteEvent[] = raw
    ? notesFromModelOutput(raw, { onsetThreshold: onset, frameThreshold: frame, minNoteFrames, pitchRange: null })
    : []
  const notes: NoteEvent[] = filterByPitchRange(notesBeforeRange, range)
  const outOfRangeCount = notesBeforeRange.length - notes.length
  const currentDiff = raw && expected.length ? pitchSequenceDiff(expected, notes.map((n) => n.pitch), octaveTolerant) : null

  async function analyze(buffer: AudioBuffer, label: string) {
    setBusy(true)
    setSweep(null)
    setSource({ label, buffer })
    try {
      setStatus('モデル読み込み中...')
      const tModel = performance.now()
      await preloadModel()
      const modelLoadMs = performance.now() - tModel

      setStatus('前処理中(22050Hzへリサンプル → 無音トリム → 音量正規化)...')
      const t0 = performance.now()
      const { buffer: analysisBuffer, ...preRest } = await preprocessForAnalysis(buffer)
      const preprocessMs = performance.now() - t0
      setPre(preRest)

      if (preRest.isSilent) {
        setRaw(null)
        setStatus('有音区間が見つかりませんでした(全編が無音と判定されました)')
        return
      }

      const t1 = performance.now()
      const output = await runModel(analysisBuffer, (p) => setStatus(`推論中... ${Math.round(p * 100)}%`))
      const inferenceMs = performance.now() - t1

      setRaw(output)
      setTimings({ modelLoadMs, preprocessMs, inferenceMs })
      setStatus(`完了(${output.frames.length}フレーム)`)
    } catch (err) {
      setRaw(null)
      setStatus('失敗: ' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const buffer = await decodeAudioBlob(file)
      await analyze(buffer, file.name)
    } catch (err) {
      setStatus('デコードに失敗しました: ' + (err as Error).message)
    }
  }

  async function toggleRecording() {
    if (!recording) {
      recorderRef.current = new Recorder()
      await recorderRef.current.start()
      setRecording(true)
      setStatus('録音中...')
      return
    }
    setRecording(false)
    const { blob } = await recorderRef.current!.stop()
    recorderRef.current = null
    const buffer = await decodeAudioBlob(blob)
    await analyze(buffer, `録音 ${new Date().toLocaleTimeString('ja-JP')}`)
  }

  /** 閾値グリッドを総当たりする。推論は再実行せず後処理のみを回す */
  async function runSweep() {
    if (!raw) return
    setBusy(true)
    const cells: SweepCell[] = []
    for (const o of ONSET_GRID) {
      for (const f of FRAME_GRID) {
        const detected = notesFromModelOutput(raw, { onsetThreshold: o, frameThreshold: f, minNoteFrames, pitchRange: range })
        cells.push({
          onset: o,
          frame: f,
          noteCount: detected.length,
          diff: expected.length ? pitchSequenceDiff(expected, detected.map((n) => n.pitch), octaveTolerant) : null,
        })
      }
      setStatus(`スイープ中... onset=${o}`)
      // 後処理は同期処理なので、途中でUIに描画の機会を渡す
      await new Promise((r) => setTimeout(r, 0))
    }
    setSweep(cells)
    setStatus('スイープ完了')
    setBusy(false)
  }

  const bestCell = sweep?.reduce<SweepCell | null>((best, c) => {
    if (!c.diff) return best
    if (!best?.diff) return c
    // 一致数が多いほど良く、同数なら誤り(欠落+余分+音高違い)が少ないほど良い
    const err = (x: PitchDiff) => x.missed + x.extra + x.substituted
    if (c.diff.matched !== best.diff.matched) return c.diff.matched > best.diff.matched ? c : best
    return err(c.diff) < err(best.diff) ? c : best
  }, null)

  return (
    <>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>
          ← 戻る
        </button>
        <h1>音符起こし検証(M1)</h1>
      </div>
      <div style={{ overflowY: 'auto' }}>
        <div className="note-block">
          実録音をアプリ本体と同じ処理経路に通し、Basic Pitchのonset/frame閾値を調整するための開発用画面です。
          Appendix Bの予備検証は合成音・Python版でのものなので、ここで実録音・ブラウザ実機での値に置き換えます。
        </div>

        <div className="section-title">1. 音源</div>
        <div className="stack">
          <button className="secondary" onClick={toggleRecording} disabled={busy && !recording}>
            {recording ? '■ 録音を停止して解析' : '● マイクで録音'}
          </button>
          <label className="secondary" style={{ display: 'block', textAlign: 'center' }}>
            📁 音声ファイルを選択
            <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleFile} disabled={busy} />
          </label>
        </div>
        <div className="note-block">
          状態: {status}
          {source && (
            <>
              <br />
              音源: {source.label} / {source.buffer.duration.toFixed(1)}秒 / {source.buffer.sampleRate}Hz /{' '}
              {source.buffer.numberOfChannels}ch
            </>
          )}
        </div>

        {pre && (
          <>
            <div className="section-title">2. 前処理の結果</div>
            <div className="metric-grid">
              <div className="metric">
                <div className="lbl">先頭トリム</div>
                <div className="val">{fmtMs(pre.trimStartMs)}</div>
              </div>
              <div className="metric">
                <div className="lbl">末尾トリム</div>
                <div className="val">{fmtMs(pre.trimEndMs)}</div>
              </div>
              <div className="metric">
                <div className="lbl">正規化ゲイン</div>
                <div className="val">×{pre.appliedGain.toFixed(2)}</div>
              </div>
            </div>
            <div className="note-block">
              正規化ゲインはテイクごとの録音レベル差の目安になります(値が大きいほど元の音が小さい)。
              テイク間でこの値が極端に違う場合、マイク位置や入力レベルが揃っていない可能性があります。
            </div>
          </>
        )}

        {timings && (
          <>
            <div className="section-title">3. 処理時間</div>
            <div className="metric-grid">
              <div className="metric">
                <div className="lbl">モデル読込</div>
                <div className="val">{fmtMs(timings.modelLoadMs ?? 0)}</div>
              </div>
              <div className="metric">
                <div className="lbl">前処理</div>
                <div className="val">{fmtMs(timings.preprocessMs)}</div>
              </div>
              <div className="metric">
                <div className="lbl">推論</div>
                <div className="val">{fmtMs(timings.inferenceMs)}</div>
              </div>
            </div>
          </>
        )}

        {raw && (
          <>
            <div className="section-title">4. 期待する音符列(任意)</div>
            <div className="note-block">
              実際に弾いた音を入力すると、検出結果との一致率を出せます。音名(C4, F#3, Bb2)でもMIDI番号(60 66)でも可。
              スペース・カンマ区切り。C4 = 中央ド = MIDI 60。
            </div>
            <input
              type="text"
              value={expectedText}
              onChange={(e) => setExpectedText(e.target.value)}
              placeholder="例: E4 F#4 G4 A4 B4 C5"
              style={{ width: 'calc(100% - 32px)', margin: '0 16px', padding: 10, boxSizing: 'border-box' }}
            />
            <label className="note-block" style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={octaveTolerant}
                onChange={(e) => setOctaveTolerant(e.target.checked)}
              />{' '}
              オクターブ違いを一致とみなす(倍音の誤検出かどうかの切り分け用)
            </label>

            <div className="section-title">5. 閾値</div>
            <div className="stack">
              <label>
                onset threshold: {onset.toFixed(2)}
                <input
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  value={onset}
                  onChange={(e) => setOnset(Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                frame threshold: {frame.toFixed(2)}
                <input
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  value={frame}
                  onChange={(e) => setFrame(Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                min note frames: {minNoteFrames}
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={minNoteFrames}
                  onChange={(e) => setMinNoteFrames(Number(e.target.value))}
                  style={{ width: '100%' }}
                />
              </label>
            </div>

            <label className="note-block" style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={applyPitchRange}
                onChange={(e) => setApplyPitchRange(e.target.checked)}
              />{' '}
              ギターの音域外(E2〜E6の外)を除去する
              <div style={{ marginTop: 4, opacity: 0.75 }}>
                閾値では消せない「物理的にありえない音」を落とします。オフにすると素の検出結果が見られるので、
                フィルタが何音を除いたかを比較できます。
              </div>
            </label>

            <div className="section-title">
              6. 検出結果({notes.length}音
              {applyPitchRange && outOfRangeCount > 0 ? ` / 音域外 ${outOfRangeCount}音を除去` : ''})
            </div>
            {/* M1本検証で観測した倍音由来の誤検出(+12/+19/+24半音が同時刻に重なる)は、
                音符一覧のテキストでは見つけにくい。ピアノロールにすると平行に並んだ帯として
                一目で分かるため、数値より先に置いている */}
            <div className="chart-block">
              <PianoRoll
                notes={notes}
                showHarmonicGuides
                height={200}
                pitchRange={applyPitchRange ? GUITAR_PITCH_RANGE : undefined}
              />
            </div>
            {currentDiff && (
              <div className="metric-grid">
                <div className="metric">
                  <div className="lbl">一致</div>
                  <div className="val">
                    {currentDiff.matched}/{expected.length}
                  </div>
                </div>
                <div className="metric">
                  <div className="lbl">欠落</div>
                  <div className="val">{currentDiff.missed}</div>
                </div>
                <div className="metric">
                  <div className="lbl">余分</div>
                  <div className="val">{currentDiff.extra}</div>
                </div>
                <div className="metric">
                  <div className="lbl">音高違い</div>
                  <div className="val">{currentDiff.substituted}</div>
                </div>
              </div>
            )}
            <div className="stack">
              <button className="secondary" onClick={() => playNoteEvents(notes)} disabled={!notes.length}>
                ▶ 検出結果を鳴らして確認
              </button>
            </div>
            <div style={{ margin: '0 16px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7 }}>
              {notes.slice(0, 60).map((n, i) => (
                <div key={i}>
                  {String(i + 1).padStart(2, '0')}. {pitchToName(n.pitch).padEnd(4)} start={String(n.startMs).padStart(5)}ms
                  dur={String(n.durationMs).padStart(5)}ms amp={(n.velocity ?? 0).toFixed(2)}
                </div>
              ))}
              {notes.length > 60 && <div>...他 {notes.length - 60} 件</div>}
            </div>

            <div className="section-title">7. 閾値スイープ</div>
            <div className="note-block">
              同じ推論結果を使い回して閾値の組み合わせを総当たりします(再推論は発生しません)。
              期待する音符列を入力している場合はセルに「一致/欠落+余分+音高違い」、未入力の場合は検出音符数を表示します。
            </div>
            <div className="stack">
              <button className="secondary" onClick={runSweep} disabled={busy}>
                {ONSET_GRID.length * FRAME_GRID.length}通りを試す
              </button>
            </div>
            {sweep && (
              <div style={{ margin: '0 16px', overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ padding: 4, textAlign: 'left' }}>onset＼frame</th>
                      {FRAME_GRID.map((f) => (
                        <th key={f} style={{ padding: 4 }}>
                          {f.toFixed(1)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ONSET_GRID.map((o) => (
                      <tr key={o}>
                        <th style={{ padding: 4, textAlign: 'left' }}>{o.toFixed(1)}</th>
                        {FRAME_GRID.map((f) => {
                          const cell = sweep.find((c) => c.onset === o && c.frame === f)!
                          const isBest = bestCell && cell.onset === bestCell.onset && cell.frame === bestCell.frame
                          return (
                            <td
                              key={f}
                              onClick={() => {
                                setOnset(o)
                                setFrame(f)
                              }}
                              style={{
                                padding: 4,
                                textAlign: 'center',
                                cursor: 'pointer',
                                border: '1px solid rgba(128,128,128,0.3)',
                                background: isBest ? 'var(--status-warning)' : 'transparent',
                                fontWeight: isBest ? 700 : 400,
                              }}
                            >
                              {cell.diff
                                ? `${cell.diff.matched}/${cell.diff.missed + cell.diff.extra + cell.diff.substituted}`
                                : cell.noteCount}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="note-block" style={{ margin: '8px 0' }}>
                  セルをタップするとその閾値が上のスライダーに反映され、検出結果を確認できます。
                  {bestCell && ` 現時点の最良: onset=${bestCell.onset.toFixed(1)} / frame=${bestCell.frame.toFixed(1)}`}
                </div>
              </div>
            )}
          </>
        )}
        <div style={{ height: 40 }} />
      </div>
    </>
  )
}
