import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db from '../db'
import { recomputeDiagnosis } from '../actions'
import { playNoteEvents } from '../preview'
import { alignForDiagnosis, type DiagnosisMetrics } from '../comparison'
import { formatProgression, type ChordDiagnosis } from '../chordRecognition'
import { LOW_CONFIDENCE } from '../gridTiming'
import PianoRoll, { type PianoRollNote } from '../components/PianoRoll'
import ChordTimeline from '../components/ChordTimeline'
import VersusCard from '../components/VersusCard'
import NextChallengeStatus from '../components/NextChallengeStatus'
import NextChallengeForm from '../components/NextChallengeForm'
import RecordAgainBar from '../components/RecordAgainBar'

type Props = {
  threadId: string
  takeId: string
  onBack: () => void
  /** 「● もう 1 回録る」。スレッド画面を autoRecord で開く */
  onRecordAgain: () => void
  /** 「一覧へ」。今日のまとめを見に戻る */
  onGoHome: () => void
}

const SUBDIVISION_LABEL: Record<number, string> = { 1: '4分', 2: '8分', 3: '3連', 4: '16分' }

/** 比較モードごとの「この数字が何を意味するか」。取り違えると診断の読み方を誤るので画面に出す */
const MODE_NOTE: Record<'prev' | 'best' | 'reference', string> = {
  prev: '直前のテイクとの比較です。前回と同じように弾けているか(=一貫性)を見ています。',
  best: 'これまでで最もばらつきが小さかったテイクとの比較です。調子の良かった日を基準にどうか、を見ています。',
  reference:
    'お手本との比較です。自己比較と違い「正しさ」に近い指標になります。自己比較でばらつきが小さいのにここで一致率が落ちる場合、毎回同じ間違いを安定して弾いている可能性があります。',
}

/**
 * お手本が楽譜ファイル由来(sourceType 'importedScore')のときの説明。お手本は人の演奏ではなく
 * 指定テンポの格子どおりの音符列なので、同じ数値でも意味が変わる(数値の定義は変えない)
 */
const SCORE_REFERENCE_NOTE =
  '楽譜から作ったお手本との比較です。お手本は楽譜どおりの音符を指定テンポの格子に並べたものなので、「出だしのばらつき」は格子からのずれ、「テンポ差」は指定 BPM との差を表します。人の演奏には揺れがあるので、ばらつきが 0 にならないのは普通です。一致率は楽譜の音をどれだけ弾けたか(採譜で拾えたか)の目安で、演奏の良し悪しを決めるものではありません。'

function signed(v: number, digits = 1) {
  const s = v.toFixed(digits)
  return v > 0 ? `+${s}` : s
}

export default function DiagnosisView({ threadId, takeId, onBack, onRecordAgain, onGoHome }: Props) {
  const [mode, setMode] = useState<'prev' | 'best' | 'reference'>('prev')
  const [result, setResult] = useState<
    (DiagnosisMetrics & { chord: ChordDiagnosis | null; comparedToTakeId: string }) | null | undefined
  >(undefined)

  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId])
  const take = useLiveQuery(() => db.takes.get(takeId), [takeId])
  const referenceTake = useLiveQuery(() => db.takes.where({ threadId, role: 'reference' }).first(), [threadId])
  const comparedTake = useLiveQuery(
    () => (result ? db.takes.get(result.comparedToTakeId) : undefined),
    [result?.comparedToTakeId],
  )
  /** 楽譜から作ったお手本と比べているか。説明文を切り替える */
  const scoreReference = mode === 'reference' && referenceTake?.sourceType === 'importedScore'

  useEffect(() => {
    let cancelled = false
    setResult(undefined)
    recomputeDiagnosis(threadId, takeId, mode).then((r) => {
      if (!cancelled) setResult(r ? { ...r.metrics, chord: r.chord, comparedToTakeId: r.comparedToTakeId } : null)
    })
    return () => {
      cancelled = true
    }
  }, [threadId, takeId, mode])

  // 診断メトリクスは集計値なので「どの音がどうズレたか」までは分からない。
  // 表示のためにアライメントをもう一度取り直す。diagnose()と同じ alignForDiagnosis を通すので
  // (分割統合・時間補正込みで)結果は一致する。
  const alignment = useMemo(() => {
    const ref = comparedTake?.noteEvents
    const cur = take?.noteEvents
    if (!ref || !cur) return null
    return alignForDiagnosis(ref, cur)
  }, [comparedTake?.noteEvents, take?.noteEvents])

  const rollNotes = useMemo<PianoRollNote[]>(() => {
    if (!alignment) return []
    return alignment.pairs.flatMap<PianoRollNote>((p) => {
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
  }, [alignment])

  const ghostNotes = useMemo<PianoRollNote[] | undefined>(
    () => alignment?.ref.map(({ pitch, startMs, durationMs }) => ({ pitch, startMs, durationMs })),
    [alignment],
  )

  if (!take) return null

  const grid = take.gridTiming
  const lowConfidence = grid ? grid.confidence < LOW_CONFIDENCE : false
  const chordMode = thread?.chordMode === true

  return (
    <>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>
          ← 戻る
        </button>
        <h1>診断結果</h1>
      </div>
      <div style={{ overflowY: 'auto' }}>
        {/* 毎日の型: まず「前回の自分と」の 3 項目の勝敗、予告の判定対象テイクなら達成/惜しいの 1 行 */}
        <VersusCard threadId={threadId} takeId={takeId} />
        <NextChallengeStatus threadId={threadId} takeId={takeId} />

        {/* 絶対指標: メトロノーム録音なら比較対象なしで出る。上に置く(これが安定度の本体) */}
        {take.metronome && (
          <>
            <div className="section-title">拍に対する安定度</div>
            {grid ? (
              <>
                <div className="stat-hero">
                  <div className="lbl">音の出だしのばらつき(標準偏差)</div>
                  <div className="val">
                    {Math.round(grid.jitterMs)}
                    <span style={{ fontSize: 16, fontWeight: 400, marginLeft: 4 }}>ms</span>
                  </div>
                  <div className="note-block" style={{ margin: '4px 0 0' }}>
                    ♩={grid.bpm} の{SUBDIVISION_LABEL[grid.subdivision]}格子(1マス{Math.round(grid.gridMs)}ms)に対して、
                    {grid.onsetCount}音の出だしがどれだけ散ったか。比較対象は要らず、日をまたいで比べられます。
                  </div>
                </div>
                <div className="metric-grid">
                  <div className="metric">
                    <div className="lbl">テンポの流れ</div>
                    <div className="val">{signed(grid.tempoDriftPct, 1)}%</div>
                  </div>
                  <div className="metric">
                    <div className="lbl">格子の一致度</div>
                    <div className="val">{Math.round(grid.confidence * 100)}%</div>
                  </div>
                  <div className="metric">
                    <div className="lbl">解析した音</div>
                    <div className="val">{grid.onsetCount}</div>
                  </div>
                </div>
                {lowConfidence && (
                  <div className="notice error">
                    音の出だしが格子に乗っていません(一致度{Math.round(grid.confidence * 100)}%)。
                    BPMか分割(4分/8分/16分)が演奏と合っていない可能性が高く、上のばらつきの値は信用できません。
                  </div>
                )}
              </>
            ) : (
              <div className="note-block">
                メトロノーム録音ですが、格子に対する解析に必要な音数が足りませんでした(カウントイン後に6音以上必要)。
              </div>
            )}
          </>
        )}

        <div className="section-title">他のテイクとの比較</div>
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
        <div className="note-block">{scoreReference ? SCORE_REFERENCE_NOTE : MODE_NOTE[mode]}</div>

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

        {/* 和音スレッド: コード進行の比較を音符単位の指標より先に出す。ストロークは Basic Pitch が
            音符に分解できないので、下の音符一致率やばらつきはこのスレッドでは目安にならない */}
        {chordMode && (
          <>
            <div className="section-title">コード進行</div>
            {take.chordEvents ? (
              result?.chord ? (
                <>
                  <div className="metric-grid">
                    <div className="metric">
                      <div className="lbl">コード一致率</div>
                      <div className="val">{Math.round(result.chord.chordMatchRate * 100)}%</div>
                    </div>
                    <div className="metric">
                      <div className="lbl">切り替えのばらつき</div>
                      <div className="val">{Math.round(result.chord.chordChangeJitterMs)}ms</div>
                    </div>
                    <div className="metric">
                      <div className="lbl">抜け/余分なコード</div>
                      <div className="val">{result.chord.missedOrExtraChordCount}</div>
                    </div>
                  </div>
                  <ChordTimeline take={take.chordEvents} pairs={result.chord.pairs} />
                  <div className="note-block">
                    音声を12音のクロマ(フーリエ変換)に落とし、メジャー/マイナー/7th/m7 のテンプレートと照合した結果です。
                    「そのコードが鳴ったか」「切り替えがいつだったか」は分かりますが、6弦のうち1本だけ押さえ違えた、
                    といった音符単位のことは分かりません。単音やアルペジオも何かのコードとして読まれます。
                    切り替えのばらつきは、全体のオフセットとテンポ差を除いた残差です。
                  </div>
                </>
              ) : (
                <>
                  <div className="chord-progression">{formatProgression(take.chordEvents, 16) || '(コードとして読める区間がありません)'}</div>
                  <ChordTimeline take={take.chordEvents} />
                  {result && (
                    <div className="note-block">比較対象のテイクに和音認識の結果が無いため、コード進行の比較は出せません。</div>
                  )}
                </>
              )
            ) : (
              <div className="note-block">
                このテイクには和音認識の結果がありません(和音認識を実装する前のテイクです)。スレッド画面で「和音の練習」を
                一度OFF→ONにすると、保存してある音声から埋め直します。
              </div>
            )}
            <div className="section-title">音符単位の比較</div>
            <div className="note-block">
              以下は音符起こし(Basic Pitch)に基づく指標です。ストロークは個々の音に安定して分解できないため、
              和音の練習では目安にとどめてください。
            </div>
          </>
        )}

        {result === undefined && <div className="note-block">計算中...</div>}
        {result === null && (
          <div className="note-block">
            比較対象がありません(このモードで比較できるテイクがまだない、またはこのテイクの音符起こしに失敗しています)。
          </div>
        )}
        {result && (
          <>
            <div className="metric-grid">
              <div className="metric">
                <div className="lbl">音符一致率</div>
                <div className="val">{Math.round(result.noteMatchRate * 100)}%</div>
              </div>
              <div className="metric">
                <div className="lbl">出だしのばらつき</div>
                <div className="val">{Math.round(result.timingJitterMs)}ms</div>
              </div>
              <div className="metric">
                <div className="lbl">弾き忘れ/余分な音</div>
                <div className="val">{result.missedOrExtraNoteCount}</div>
              </div>
              <div className="metric">
                <div className="lbl">テンポ差</div>
                <div className="val">{signed(result.tempoDiffPct, 1)}%</div>
              </div>
              <div className="metric">
                <div className="lbl">対応が付いた音</div>
                <div className="val">{result.alignedNoteCount}</div>
              </div>
              <div className="metric">
                <div className="lbl">統合した分割音</div>
                <div className="val">{result.mergedNoteCount}</div>
              </div>
            </div>
            <div className="note-block">
              {scoreReference ? (
                <>
                  ばらつきは、楽譜の格子に対して全体のオフセット({signed(result.onsetOffsetMs, 0)}ms)とテンポ差を取り除いた後の残差です。
                  テンポ差は指定した BPM(♩={comparedTake?.scoreImport?.tempoBpm ?? '—'})に対する速さの違いです(正 = 速い)。
                </>
              ) : (
                <>
                  ばらつきは、全体のオフセット({signed(result.onsetOffsetMs, 0)}ms)とテンポ差を取り除いた後の残差です。
                  出だしの間の取り方や速さの違いは不安定さとして数えていません。
                </>
              )}
              「統合した分割音」は、鳴り続けている音に立った偽のオンセットを1音に畳んだ数で、両テイクの合計です。
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
              {scoreReference ? '薄い灰色は楽譜から作ったお手本の音符です。' : '薄い灰色は比較対象(基準)のテイクです。'}色付きが今回のテイクで、基準と照らし合わせた結果を表しています。
              どちらも分割統合後の音符です。
            </div>
          </>
        )}

        {/* 締め: 明日の予告 → 「もう 1 回」バー。バーは sticky なのでスクロール領域の最後の子に置く */}
        <NextChallengeForm threadId={threadId} takeId={takeId} />
        <RecordAgainBar threadId={threadId} takeId={takeId} onRecordAgain={onRecordAgain} onGoHome={onGoHome} />
      </div>
    </>
  )
}
