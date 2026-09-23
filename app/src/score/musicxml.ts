// MusicXML(score-partwise)→ NoteEvent[] の変換の核。依存ゼロ。
//
// 方針
//  - 時刻はまず「四分音符単位の絶対位置(quarter = tick)」で組み立て(ScoreTimeline)、最後にテンポマップで ms に落とす。
//    小節範囲の切り出し(sliceMeasures)と BPM 変更(retime)はこの中間表現に対して行い、ms 展開をやり直す。
//    <duration> は連符(<time-modification>)込みの実効長なので、連符の特別扱いは不要。
//  - 反復(<repeat>/<ending>)は演奏順に展開してから音符を並べる。タイの結合も演奏順で行う。
//  - 音高は <pitch> + <transpose>(chromatic / octave-change)で実音 MIDI にする。
//    <clef-octave-change>(8vb ト音記号)は見た目だけなので加算しない(MusicXML 仕様)。
//    TAB の string/fret + staff-tuning からも実音を求め、照合(警告)にだけ使う。
//  - 「パート×譜表」を 1 単位とみなし、単位同士で音符集合がほぼ一致すれば重複(五線+TAB)として 1 つに絞る。
//  - ギター音域(MIDI 40〜88)の外の音は落とさず、warning で知らせる(ドロップ D 等の変則調弦)。
import type { NoteEvent } from '../db'
import { pitchToName } from '../pitchNames.ts'
import { child, children, text, num, find, fromDomDocument, type XEl } from './xmlTree.ts'

export type ConvertOptions = {
  /** 指定すると楽譜内のテンポを無視して一定 BPM(四分音符)で展開する */
  bpm?: number
  /** 楽譜にテンポが無く bpm も無い場合の既定(既定 100) */
  fallbackBpm?: number
  /** 反復記号を展開するか(既定 true) */
  expandRepeats?: boolean
  /** 装飾音の扱い。'keep' = 主音の直前に短く置く / 'drop' = 捨てる(既定 keep) */
  grace?: 'keep' | 'drop'
  /** 装飾音 1 つの長さ(ms)。既定 70 */
  graceMs?: number
  /** 単位(パート×譜表)の重複判定閾値(既定 0.9) */
  dedupThreshold?: number
  /** フェルマータの付いた音の長さの倍率(既定 2 = MuseScore の MIDI 書き出しと同じ)。1 で無視 */
  fermataStretch?: number
}

/** パート×譜表の 1 単位(ギター譜では五線と TAB がそれぞれ 1 単位になる) */
export type ScorePart = {
  /** `${partId}/${staff}` */
  key: string
  partId: string
  partName: string
  staff: number
  isTab: boolean
  transposeSemitones: number
  clefOctaveChange: number
  noteCount: number
  /** tuning+fret から求めた音高と <pitch>+transpose の差(半音)の最頻値。0 が正常、12 は旧 MuseScore の tuning 書き方 */
  tabPitchDeltaMode?: number
  tabPitchChecked: number
  /** 出力に採用した単位か */
  chosen: boolean
  /** 重複として除いた場合、残した方の key */
  duplicateOf?: string
}

export type ScoreWarningCode =
  | 'variant-tuning' // ギター最低音(E2 = 40)より低い音がある。ドロップ D 等
  | 'above-range' // MIDI 88 より高い音がある
  | 'no-tempo' // 楽譜にテンポが無く既定値を使った
  | 'unterminated-ties' // 開始の無いタイ終端を新しい音として扱った
  | 'octave-duplicate' // 五線と TAB がオクターブ違いで重複(transpose 欠落の疑い)
  | 'tab-pitch-mismatch' // tuning+fret の音高が <pitch> と一致しない
  | 'unsupported-jump' // D.C. / D.S. / Coda / Segno / Fine を展開していない
  | 'measure-repeat' // <measure-repeat> 未対応
  | 'arpeggiate' // アルペジオ記号を同時発音として扱った
  | 'ornament' // トレモロ・トリル等を 1 音として扱った
  | 'chord-heavy' // 和音の音が多い(音符単位の診断対象外)
  | 'fast-notes' // 最短音間隔が 300 ms 未満
  | 'measure-length-mismatch' // 拍子と実長が一致しない小節(ピックアップ等)
  | 'empty' // 音符が 1 つも無い

export type ScoreWarning = {
  code: ScoreWarningCode
  /** 'warn' = 取り込み結果に影響しうる / 'info' = 参考情報 */
  level: 'warn' | 'info'
  /** 日本語の説明文(UI にそのまま出せる) */
  message: string
  /** 該当した数(あれば) */
  count?: number
}

/** 演奏順に並べた小節。反復展開で同じ小節が複数回現れる */
export type PlayedMeasure = {
  /** 楽譜上の小節インデックス(0 始まり) */
  index: number
  /** 楽譜の小節番号(<measure number>。MuseScore のピックアップは "0") */
  number: string
  /** この小節を演奏する回数目(1 始まり。反復で 2 回目なら 2) */
  pass: number
  startMs: number
  endMs: number
}

export type ScoreStats = {
  title: string
  software: string
  /** 楽譜上の小節数 */
  measureCount: number
  /** 演奏順に展開した小節数(切り出し後はその範囲) */
  playedMeasureCount: number
  /** 反復記号があったか */
  hasRepeats: boolean
  /** 反復を展開して小節数が増えたか */
  repeatsExpanded: boolean
  noteCount: number
  /** 同じ開始時刻に他の音がある音(和音の構成音)の数 */
  chordNoteCount: number
  chordRatio: number
  pitchRange: [number, number] | null
  /** ギター最低音 E2(40)より低い音の数(落とさず含めている) */
  belowGuitarRange: number
  /** MIDI 88 より高い音の数 */
  aboveGuitarRange: number
  /** 異なる開始時刻の最短間隔(ms)。音が 1 つ以下なら null */
  minInterOnsetMs: number | null
  durationMs: number
  tiesMerged: number
  unterminatedTies: number
  graceNotes: number
  graceDropped: number
  tupletNotes: number
  rests: number
  measureLengthMismatches: number
  /** 重複として除いた単位の key */
  duplicateParts: string[]
  arpeggiates: number
  ornaments: number
  measureRepeats: number
  /** 展開していない反復指示(D.C. 等)の文言 */
  jumpMarks: string[]
}

export type TimelineNote = {
  /** 絶対位置(四分音符単位) */
  q: number
  durQ: number
  pitch: number
  velocity?: number
  /**
   * 装飾音なら、主音に対する並び。q は基準位置(前打音 = 主音の開始、後打音 = 前の主音の終端)で、
   * ms 展開時に q の手前へ (size - index) × graceMs だけ遡って置く。after = 後打音(steal-time-previous)
   */
  grace?: { index: number; size: number; after: boolean }
}

export type TimelineMeasure = { index: number; number: string; pass: number; q: number; lenQ: number }

/** tick(四分音符)ベースの中間表現。ms は含まない */
export type ScoreTimeline = {
  notes: TimelineNote[]
  measures: TimelineMeasure[]
  /** 楽譜由来のテンポマップ(q 昇順、同位置は 1 つ)。空なら楽譜にテンポ無し */
  tempos: { q: number; bpm: number }[]
  /** フェルマータで伸ばす区間(結合済み) */
  fermatas: { s: number; e: number }[]
  totalQ: number
}

export type RenderOptions = {
  /** 指定があれば楽譜のテンポを無視して一定 BPM */
  bpm?: number
  fallbackBpm: number
  graceMs: number
  fermataStretch: number
}

type ParseStats = Omit<
  ScoreStats,
  'noteCount' | 'chordNoteCount' | 'chordRatio' | 'pitchRange' | 'belowGuitarRange' | 'aboveGuitarRange' | 'minInterOnsetMs' | 'durationMs' | 'playedMeasureCount'
>

export type ScoreConversion = {
  notes: NoteEvent[]
  measures: PlayedMeasure[]
  /** 0 ms 時点のテンポ(四分音符 BPM)。retime 後は指定値 */
  tempoBpm: number
  /** 'score' = 楽譜のテンポ記号 / 'default' = 楽譜に無いので既定値 / 'override' = 引数で指定 */
  tempoSource: 'score' | 'default' | 'override'
  warnings: ScoreWarning[]
  stats: ScoreStats
  parts: ScorePart[]
  /** tick ベースの中間表現。sliceMeasures / retime が使う */
  timeline: ScoreTimeline
  /** 再展開に必要な入力(UI は触らない) */
  internal: { render: RenderOptions; parseWarnings: ScoreWarning[]; parseStats: ParseStats }
}

export const GUITAR_LOW = 40
export const GUITAR_HIGH = 88
const FAST_NOTE_MS = 300
const CHORD_HEAVY_RATIO = 0.3
/** 音高クラスだけで重複と判定するのに必要な最小音数(音数が極少の単位での誤判定を抑える) */
const MIN_NOTES_FOR_OCTAVE_DEDUP = 4

type RawNote = {
  q: number // 小節内の位置(quarter)
  durQ: number
  pitch: number
  voice: string
  staff: number
  tieStart: boolean
  tieStop: boolean
  grace: boolean
  gracePrevious: boolean // steal-time-previous(前の音の後ろに付く装飾)
  graceAfter: boolean // 前の主音の後ろに付けた装飾音
  chord: boolean
  tuplet: boolean
  fermata: boolean
  arpeggiate: boolean
  ornament: boolean
  tabPitch?: number
  velocity?: number
}

type RawMeasure = {
  index: number
  number: string
  lenQ: number
  notes: RawNote[]
  tempos: { q: number; bpm: number }[]
  repeatForward: boolean
  repeatBackward: boolean
  repeatTimes: number
  repeatTimesExplicit: boolean
  endingNumbers: number[] | null
  endingType: 'start' | 'stop' | 'discontinue' | null
  endingClose: boolean
  timeSigQ: number | null
  rests: number
  /** フェルマータ付きの休符(音符と同様に伸ばす) */
  restFermatas: { q: number; durQ: number }[]
  mismatch: boolean
  measureRepeat: boolean
  jumpMarks: string[]
}

const STEP_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

function pitchToMidi(p: XEl): number {
  const step = text(child(p, 'step'))
  const alter = num(child(p, 'alter'), 0)
  const octave = num(child(p, 'octave'), 4)
  return 12 * (octave + 1) + (STEP_SEMITONE[step] ?? 0) + alter
}

function beatUnitQuarters(unit: string): number {
  switch (unit) {
    case 'whole':
      return 4
    case 'half':
      return 2
    case 'quarter':
      return 1
    case 'eighth':
      return 0.5
    case '16th':
      return 0.25
    case '32nd':
      return 0.125
    default:
      return 1
  }
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key)
  if (arr) arr.push(value)
  else map.set(key, [value])
}

function parseEndingNumbers(s: string): number[] {
  return s
    .split(/[,\s]+/)
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isFinite(x))
}

const JUMP_WORDS = /(^|[^A-Za-z])(D\.\s?C\.|D\.\s?S\.|Da\s+Capo|Dal\s+Segno|To\s+Coda|Fine)(?![A-Za-z])/i

/** パート単位の状態(小節をまたいで持ち越す) */
type PartState = {
  divisions: number
  transpose: Map<number, number> // staff → 半音(0 = 全譜表)
  clefOctave: Map<number, number>
  tabStaves: Set<number>
  tuning: Map<number, Map<number, number>> // staff → (string line → midi)
  staves: number
  /** 現在の拍子の長さ(quarter)。<time> は変わるまで持ち越す */
  timeSigQ: number | null
}

function parsePart(part: XEl, st: PartState): RawMeasure[] {
  const measures: RawMeasure[] = []
  let idx = 0
  for (const m of children(part, 'measure')) {
    const rm: RawMeasure = {
      index: idx++,
      number: m.attrs.number ?? String(idx),
      lenQ: 0,
      notes: [],
      tempos: [],
      repeatForward: false,
      repeatBackward: false,
      repeatTimes: 2,
      repeatTimesExplicit: false,
      endingNumbers: null,
      endingType: null,
      endingClose: false,
      timeSigQ: st.timeSigQ,
      rests: 0,
      restFermatas: [],
      mismatch: false,
      measureRepeat: false,
      jumpMarks: [],
    }
    rm.timeSigQ = st.timeSigQ // <attributes> は小節の先頭以外にも来るが、拍子は小節単位で見る
    let pos = 0 // divisions 単位
    let maxPos = 0
    let lastNonChord: RawNote | null = null
    let lastPrincipal: RawNote | null = null
    let pendingGraces: RawNote[] = []

    for (const el of m.children) {
      switch (el.name) {
        case 'attributes': {
          const d = num(child(el, 'divisions'))
          if (d > 0) st.divisions = d
          const stv = num(child(el, 'staves'))
          if (stv > 0) st.staves = stv
          const ts = child(el, 'time')
          if (ts) {
            const beats = text(child(ts, 'beats'))
            const bt = num(child(ts, 'beat-type'))
            // "3+2" のような複合拍子にも対応
            const b = beats.split('+').reduce((a, x) => a + (Number(x) || 0), 0)
            if (b > 0 && bt > 0) st.timeSigQ = (b * 4) / bt
          }
          for (const tr of children(el, 'transpose')) {
            const staff = Number(tr.attrs.number ?? 0)
            const semis = num(child(tr, 'chromatic'), 0) + 12 * num(child(tr, 'octave-change'), 0)
            st.transpose.set(staff, semis)
          }
          for (const clef of children(el, 'clef')) {
            const staff = Number(clef.attrs.number ?? 1)
            if (text(child(clef, 'sign')) === 'TAB') st.tabStaves.add(staff)
            else st.tabStaves.delete(staff)
            st.clefOctave.set(staff, num(child(clef, 'clef-octave-change'), 0))
          }
          for (const sd of children(el, 'staff-details')) {
            const staff = Number(sd.attrs.number ?? 1)
            const tun = new Map<number, number>()
            for (const t of children(sd, 'staff-tuning')) {
              const line = Number(t.attrs.line)
              const midi = 12 * (num(child(t, 'tuning-octave'), 4) + 1) + (STEP_SEMITONE[text(child(t, 'tuning-step'))] ?? 0) + num(child(t, 'tuning-alter'), 0)
              tun.set(line, midi)
            }
            if (tun.size) st.tuning.set(staff, tun)
          }
          for (const ms of children(el, 'measure-style')) {
            const mr = child(ms, 'measure-repeat')
            if (mr && mr.attrs.type !== 'stop') rm.measureRepeat = true
          }
          break
        }
        case 'direction': {
          const snd = child(el, 'sound')
          const t = snd ? Number(snd.attrs.tempo) : NaN
          if (Number.isFinite(t) && t > 0) {
            rm.tempos.push({ q: pos / st.divisions, bpm: t })
          } else {
            // <direction-type> は複数並ぶ(「Larghetto」の words の後に metronome など)ので direction 全体から探す
            const metro = find(el, 'metronome')
            if (metro) {
              const pm = num(child(metro, 'per-minute'))
              const unit = text(child(metro, 'beat-unit'))
              const dotted = !!child(metro, 'beat-unit-dot')
              if (pm > 0) rm.tempos.push({ q: pos / st.divisions, bpm: pm * beatUnitQuarters(unit) * (dotted ? 1.5 : 1) })
            }
          }
          if (snd) {
            for (const k of ['dacapo', 'dalsegno', 'tocoda', 'fine', 'segno', 'coda']) if (snd.attrs[k] !== undefined) rm.jumpMarks.push(k)
          }
          for (const dt of children(el, 'direction-type')) {
            if (child(dt, 'segno')) rm.jumpMarks.push('segno')
            if (child(dt, 'coda')) rm.jumpMarks.push('coda')
            for (const w of children(dt, 'words')) {
              const s = text(w)
              if (JUMP_WORDS.test(s)) rm.jumpMarks.push(s)
            }
          }
          break
        }
        case 'sound': {
          const t = Number(el.attrs.tempo)
          if (Number.isFinite(t) && t > 0) rm.tempos.push({ q: pos / st.divisions, bpm: t })
          break
        }
        case 'backup':
          pos = Math.max(0, pos - num(child(el, 'duration'), 0))
          break
        case 'forward':
          pos += num(child(el, 'duration'), 0)
          maxPos = Math.max(maxPos, pos)
          break
        case 'barline': {
          const rep = child(el, 'repeat')
          if (rep) {
            if (rep.attrs.direction === 'forward') rm.repeatForward = true
            if (rep.attrs.direction === 'backward') {
              rm.repeatBackward = true
              const times = Number(rep.attrs.times)
              if (Number.isFinite(times) && times > 0) {
                rm.repeatTimes = times
                rm.repeatTimesExplicit = true
              }
            }
          }
          const ending = child(el, 'ending')
          if (ending) {
            const type = ending.attrs.type as RawMeasure['endingType']
            if (type === 'start') {
              rm.endingNumbers = parseEndingNumbers(ending.attrs.number ?? '')
              rm.endingType = 'start'
            } else if (type === 'stop' || type === 'discontinue') {
              // start と stop が同じ小節に来る(1 小節の volta)場合は start を残す
              if (!rm.endingNumbers) rm.endingNumbers = parseEndingNumbers(ending.attrs.number ?? '')
              if (rm.endingType !== 'start') rm.endingType = type
              rm.endingClose = true
            }
          }
          break
        }
        case 'note': {
          const graceEl = child(el, 'grace')
          const isGrace = !!graceEl
          const isCue = !!child(el, 'cue')
          const isChord = !!child(el, 'chord')
          const dur = num(child(el, 'duration'), 0)
          const staff = Number(text(child(el, 'staff')) || 1)
          const voice = text(child(el, 'voice')) || '1'
          const rest = child(el, 'rest')
          const pitchEl = child(el, 'pitch')
          const notations = child(el, 'notations')

          const startPos = isChord && lastNonChord ? lastNonChord.q * st.divisions : pos
          if (rest || isCue || !pitchEl) {
            if (rest) {
              rm.rests++
              if (find(notations, 'fermata')) rm.restFermatas.push({ q: startPos / st.divisions, durQ: dur / st.divisions })
            }
            if (!isChord && !isGrace) {
              pos = startPos + dur
              maxPos = Math.max(maxPos, pos)
            }
            break
          }

          const written = pitchToMidi(pitchEl)
          const tr = st.transpose.get(staff) ?? st.transpose.get(0) ?? 0
          const pitch = written + tr

          const tech = find(notations, 'technical')
          let tabPitch: number | undefined
          if (tech) {
            const str = num(child(tech, 'string'))
            const fret = num(child(tech, 'fret'))
            const tun = st.tuning.get(staff)
            if (tun && Number.isFinite(str) && Number.isFinite(fret)) {
              // staff-tuning の line は下から数える(line 1 = 最低音弦)。string は 1 = 最高音弦
              const lines = tun.size
              const open = tun.get(lines - str + 1)
              if (open !== undefined) tabPitch = open + fret
            }
          }

          const ties = children(el, 'tie')
          let tieStart = ties.some((t) => t.attrs.type === 'start')
          let tieStop = ties.some((t) => t.attrs.type === 'stop')
          if (!ties.length) {
            const tied = children(notations, 'tied')
            tieStart = tied.some((t) => t.attrs.type === 'start')
            tieStop = tied.some((t) => t.attrs.type === 'stop')
          }
          const rn: RawNote = {
            q: startPos / st.divisions,
            durQ: dur / st.divisions,
            pitch,
            voice,
            staff,
            tieStart,
            tieStop,
            grace: isGrace,
            gracePrevious: !!graceEl && graceEl.attrs['steal-time-previous'] !== undefined,
            graceAfter: false,
            chord: isChord,
            tuplet: !!child(el, 'time-modification'),
            fermata: !!find(notations, 'fermata'),
            arpeggiate: !!child(notations, 'arpeggiate'),
            ornament: !!find(notations, 'ornaments'),
            tabPitch,
          }
          // <note dynamics="90"> はフォルテ(MIDI velocity 90)を 100 とする百分率
          const dyn = Number(el.attrs.dynamics)
          if (Number.isFinite(dyn) && dyn > 0) rn.velocity = Math.min(1, Math.max(0.1, ((dyn / 100) * 90) / 127))

          if (isGrace) {
            pendingGraces.push(rn)
            rm.notes.push(rn)
            break
          }
          rm.notes.push(rn)
          if (!isChord) {
            // 直前に溜まった装飾音はこの主音に付ける(位置は主音と同じにしておき、ms 化の段で前にずらす)
            if (pendingGraces.length) {
              const anchor = pendingGraces[0].gracePrevious && lastPrincipal ? lastPrincipal : rn
              for (const g of pendingGraces) {
                g.q = anchor === rn ? rn.q : anchor.q + anchor.durQ
                g.graceAfter = anchor !== rn
              }
              pendingGraces = []
            }
            lastNonChord = rn
            lastPrincipal = rn
            pos = startPos + dur
            maxPos = Math.max(maxPos, pos)
          }
          break
        }
        default:
          break
      }
    }
    // 小節末に残った装飾音(次の小節の頭に付く)は、簡略化して小節末に置く
    for (const g of pendingGraces) g.q = maxPos / st.divisions
    rm.lenQ = rm.timeSigQ ?? maxPos / st.divisions
    if (rm.timeSigQ !== null && Math.abs(rm.timeSigQ - maxPos / st.divisions) > 1e-6 && m.attrs.implicit !== 'yes') {
      // ピックアップ小節や不完全小節。長さは実際に埋まった分を採用する
      rm.lenQ = maxPos / st.divisions
      rm.mismatch = true
    }
    if (m.attrs.implicit === 'yes') rm.lenQ = maxPos / st.divisions
    measures.push(rm)
  }
  return measures
}

/** 反復記号を展開して演奏順の小節インデックス列を返す */
function expandRepeatOrder(measures: RawMeasure[]): number[] {
  const order: number[] = []
  const n = measures.length
  let i = 0
  let repeatStart = 0
  const passes = new Map<number, number>()
  const pass = () => passes.get(repeatStart) ?? 1
  const limit = n * 32 + 64
  let justJumped = false
  while (i < n && order.length < limit) {
    const m = measures[i]
    const arrivedByJump = justJumped
    justJumped = false
    // 1. volta の判定(直前の反復ブロックの回数に対して)。反復開始点に戻ってきた直後は判定しない
    //    (「2 番括弧の開始小節 = 次のブロックの反復開始」が同居する譜面で、その括弧は前ブロックのもの)
    if (!arrivedByJump && m.endingType === 'start' && m.endingNumbers && m.endingNumbers.length && !m.endingNumbers.includes(pass())) {
      // この回では弾かない volta。終了小節まで飛ばす
      let j = i
      while (j < n) {
        if (measures[j].endingClose) break
        j++
      }
      // 括弧が反復終端の縦線より手前で閉じている譜面(「1.」が m33 のみで、反復終端は m34)では、
      // 括弧の外に残った小節も 1 番括弧の続きとして飛ばす(MuseScore と同じ挙動)
      for (let k = j + 1; k < n; k++) {
        const mk = measures[k]
        if (mk.endingType === 'start' || mk.repeatForward) break
        if (mk.repeatBackward) {
          j = k
          break
        }
      }
      i = j + 1
      // 飛ばした括弧の中に反復終端があっても、ここで回数を消してはいけない
      // (直後の 2 番括弧の判定に「今が何回目か」が要る)。ブロックの終了は最終括弧を弾き終えた時に処理する
      continue
    }
    // 2. 反復終端の無い最終括弧(discontinue 等)= 前ブロックの終了。
    //    ただし、この括弧の後ろ(次の括弧/反復開始より前)に反復終端が続くなら、まだブロックの途中
    if (!arrivedByJump && m.endingClose && m.endingNumbers && m.endingNumbers.length && !m.repeatBackward) {
      let closes = true
      for (let k = i + 1; k < n; k++) {
        const mk = measures[k]
        if (mk.repeatBackward) {
          closes = false
          break
        }
        if (mk.endingType === 'start' || mk.repeatForward) break
      }
      if (closes) {
        passes.delete(repeatStart)
        repeatStart = i + 1
      }
    }
    // 3. 反復開始記号 = 新しいブロック
    if (m.repeatForward) {
      repeatStart = i
      if (!passes.has(i)) passes.set(i, 1)
    }
    order.push(i)
    if (m.repeatBackward) {
      // times 属性が無い反復の回数は、ブロック内の括弧番号の最大値(「1, 2, 3」括弧なら 3 回戻る)。括弧が無ければ 2
      let times = m.repeatTimes
      if (!m.repeatTimesExplicit) {
        let maxEnding = 0
        for (let k = repeatStart; k <= i; k++) for (const e of measures[k].endingNumbers ?? []) maxEnding = Math.max(maxEnding, e)
        // 反復終端の直後に続く最終括弧(「4.」など)もこのブロックの回数に含める
        for (let k = i + 1; k < n && measures[k].endingNumbers; k++) {
          for (const e of measures[k].endingNumbers ?? []) maxEnding = Math.max(maxEnding, e)
          if (measures[k].endingClose) break
        }
        times = Math.max(2, maxEnding)
      }
      if (pass() < times) {
        passes.set(repeatStart, pass() + 1)
        i = repeatStart
        justJumped = true
        continue
      }
      // 繰り返し終了。次の反復ブロックに備えて開始点を進める
      passes.delete(repeatStart)
      repeatStart = i + 1
    }
    i++
  }
  return order
}

type Placed = { q: number; durQ: number; pitch: number; velocity?: number; grace: boolean; graceAfter: boolean; unit: string }

function isDomDocument(x: unknown): x is Document {
  return typeof x === 'object' && x !== null && 'nodeType' in x && (x as { nodeType: number }).nodeType === 9
}

/**
 * MusicXML(パース済みツリー、または DOM の Document)を NoteEvent[] に変換する。
 * score-timewise・パート無し・整形式でない XML は Error を投げる。
 */
export function convertMusicXml(source: XEl | Document, opts: ConvertOptions = {}): ScoreConversion {
  const doc = isDomDocument(source) ? fromDomDocument(source) : source
  const parseWarnings: ScoreWarning[] = []
  const score = doc.name === 'score-partwise' ? doc : child(doc, 'score-partwise')
  if (!score) {
    if (child(doc, 'score-timewise') || doc.name === 'score-timewise') throw new Error('score-timewise 形式は未対応です(score-partwise で書き出してください)')
    throw new Error('MusicXML(score-partwise)ではありません')
  }
  const software = text(find(child(score, 'identification'), 'software'))
  const title = text(child(child(score, 'work'), 'work-title')) || text(child(score, 'movement-title'))

  const partNames = new Map<string, string>()
  for (const sp of children(child(score, 'part-list'), 'score-part')) partNames.set(sp.attrs.id, text(child(sp, 'part-name')))

  // --- 1. パートごとに小節を読む ---
  type ParsedPart = { id: string; state: PartState; measures: RawMeasure[] }
  const parts: ParsedPart[] = []
  for (const p of children(score, 'part')) {
    const state: PartState = { divisions: 1, transpose: new Map(), clefOctave: new Map(), tabStaves: new Set(), tuning: new Map(), staves: 1, timeSigQ: null }
    parts.push({ id: p.attrs.id, state, measures: parsePart(p, state) })
  }
  if (!parts.length) throw new Error('パートが 1 つもありません')

  // --- 2. 単位(パート×譜表)の情報と重複判定 ---
  const units: ScorePart[] = []
  const unitSig = new Map<string, Set<string>>()
  const unitSigPc = new Map<string, Set<string>>()
  for (const p of parts) {
    const byStaff = new Map<number, RawNote[]>()
    for (const m of p.measures) for (const nn of m.notes) pushTo(byStaff, nn.staff, nn)
    const staffs = byStaff.size ? [...byStaff.keys()].sort((a, b) => a - b) : [1]
    for (const s of staffs) {
      const key = `${p.id}/${s}`
      const notes = byStaff.get(s) ?? []
      const deltas = new Map<number, number>()
      let checked = 0
      for (const nn of notes) {
        if (nn.tabPitch !== undefined) {
          checked++
          const d = nn.tabPitch - nn.pitch
          deltas.set(d, (deltas.get(d) ?? 0) + 1)
        }
      }
      let mode: number | undefined
      let best = 0
      for (const [d, c] of deltas) {
        if (c > best) {
          best = c
          mode = d
        }
      }
      units.push({
        key,
        partId: p.id,
        partName: partNames.get(p.id) ?? '',
        staff: s,
        isTab: p.state.tabStaves.has(s),
        transposeSemitones: p.state.transpose.get(s) ?? p.state.transpose.get(0) ?? 0,
        clefOctaveChange: p.state.clefOctave.get(s) ?? 0,
        noteCount: notes.length,
        tabPitchDeltaMode: mode,
        tabPitchChecked: checked,
        chosen: false,
      })
      const sig = new Set<string>()
      const sigPc = new Set<string>()
      for (const m of p.measures)
        for (const nn of m.notes) {
          if (nn.staff !== s || nn.grace) continue
          sig.add(`${m.index}:${nn.q.toFixed(4)}:${nn.pitch}`)
          sigPc.add(`${m.index}:${nn.q.toFixed(4)}:${((nn.pitch % 12) + 12) % 12}`)
        }
      unitSig.set(key, sig)
      unitSigPc.set(key, sigPc)
    }
  }
  const overlap = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    return inter / Math.max(a.size, b.size)
  }
  const thr = opts.dedupThreshold ?? 0.9
  // 優先度: 五線(非 TAB) > TAB。ただし五線側の音高が TAB の tuning+fret と 12 半音ズレていて、
  // かつ音高クラスでは一致(= 五線側の transpose 欠落)なら TAB を優先する
  const sorted = [...units].sort((a, b) => Number(a.isTab) - Number(b.isTab) || b.noteCount - a.noteCount)
  for (const u of sorted) {
    if (u.duplicateOf) continue
    for (const v of sorted) {
      if (v === u || v.duplicateOf) continue
      const exact = overlap(unitSig.get(u.key)!, unitSig.get(v.key)!)
      if (exact >= thr) {
        v.duplicateOf = u.key
        continue
      }
      if (Math.min(u.noteCount, v.noteCount) < MIN_NOTES_FOR_OCTAVE_DEDUP) continue
      const pc = overlap(unitSigPc.get(u.key)!, unitSigPc.get(v.key)!)
      if (pc >= thr) {
        // オクターブ違いで重複している。TAB 側で tuning+fret の照合が取れていれば TAB を採用
        const tab = u.isTab ? u : v.isTab ? v : null
        const staff = tab === u ? v : u
        if (tab && tab.tabPitchDeltaMode === 0) {
          staff.duplicateOf = tab.key
          parseWarnings.push({
            code: 'octave-duplicate',
            level: 'warn',
            message: `五線(${staff.key})と TAB(${tab.key})の音がオクターブ違いで重複しています。五線側の移調指定(transpose)が欠けている可能性があるため TAB 側の音高を採用しました`,
          })
          if (staff === u) break
        } else {
          v.duplicateOf = u.key
          parseWarnings.push({
            code: 'octave-duplicate',
            level: 'warn',
            message: `${u.key} と ${v.key} の音がオクターブ違いで重複しています。${u.isTab ? 'TAB' : '五線'}側(${u.key})を採用しました。音域を確認してください`,
          })
        }
      }
    }
  }
  for (const u of units) u.chosen = !u.duplicateOf && u.noteCount > 0
  const chosen = new Set(units.filter((u) => u.chosen).map((u) => u.key))

  // --- 3. 反復展開(先頭パートの小節構造を基準にする) ---
  const base = parts[0].measures
  const doExpand = opts.expandRepeats ?? true
  const hasRepeats = base.some((m) => m.repeatForward || m.repeatBackward || m.endingNumbers)
  const order = doExpand ? expandRepeatOrder(base) : base.map((m) => m.index)

  // 小節長はパート間で最大を取る(不完全な声部を持つパートが短く見えるのを避ける)
  const lenQ = base.map((_, i) => Math.max(...parts.map((p) => p.measures[i]?.lenQ ?? 0)))

  // --- 4. 演奏順に配置しつつタイを結合 ---
  const placed: Placed[] = []
  const tempoEvents: { q: number; bpm: number }[] = []
  const fermataRegions: { s: number; e: number }[] = []
  const tlMeasures: TimelineMeasure[] = []
  const passCount = new Map<number, number>()
  let cursorQ = 0
  let tiesMerged = 0
  let unterminated = 0
  let graceCount = 0
  let tupletNotes = 0
  let rests = 0
  let mismatches = 0
  let arpeggiates = 0
  let ornaments = 0
  let measureRepeats = 0
  const jumpMarks: string[] = []
  const openTies = new Map<string, { pl: Placed; endQ: number }>() // key: unit|voice|pitch
  const keepGrace = (opts.grace ?? 'keep') === 'keep'

  for (const mi of order) {
    const pass = (passCount.get(mi) ?? 0) + 1
    passCount.set(mi, pass)
    tlMeasures.push({ index: mi, number: base[mi].number, pass, q: cursorQ, lenQ: lenQ[mi] })
    for (const p of parts) {
      const m = p.measures[mi]
      if (!m) continue
      if (m.mismatch) mismatches++
      if (p === parts[0]) {
        for (const t of m.tempos) tempoEvents.push({ q: cursorQ + t.q, bpm: t.bpm })
        for (const f of m.restFermatas) fermataRegions.push({ s: cursorQ + f.q, e: cursorQ + f.q + f.durQ })
        if (m.measureRepeat) measureRepeats++
        for (const j of m.jumpMarks) if (!jumpMarks.includes(j)) jumpMarks.push(j)
      }
      rests += m.rests
      for (const nn of m.notes) {
        const unit = `${p.id}/${nn.staff}`
        if (!chosen.has(unit)) continue
        if (nn.tuplet) tupletNotes++
        if (nn.arpeggiate) arpeggiates++
        if (nn.ornament) ornaments++
        const qAbs = cursorQ + nn.q
        if (nn.grace) {
          graceCount++
          if (keepGrace) placed.push({ q: qAbs, durQ: 0, pitch: nn.pitch, velocity: nn.velocity, grace: true, graceAfter: nn.graceAfter, unit })
          continue
        }
        // フェルマータはタイで結合される音の末尾に付くことが多いので、結合前にここで区間を記録する
        if (nn.fermata) fermataRegions.push({ s: qAbs, e: qAbs + nn.durQ })
        const tieKey = `${unit}|${nn.voice}|${nn.pitch}`
        if (nn.tieStop) {
          let open = openTies.get(tieKey)
          if (!open) {
            // 声部が変わってタイが続くことがあるので、同じ単位・同じ音高で終端が一致するものを探す
            for (const [k, o] of openTies) {
              if (k.startsWith(`${unit}|`) && k.endsWith(`|${nn.pitch}`) && Math.abs(o.endQ - qAbs) < 1e-6) {
                open = o
                openTies.delete(k)
                break
              }
            }
          } else openTies.delete(tieKey)
          if (open && Math.abs(open.endQ - qAbs) < 1e-3) {
            open.endQ = qAbs + nn.durQ
            open.pl.durQ = open.endQ - open.pl.q
            tiesMerged++
            if (nn.tieStart) openTies.set(tieKey, open)
            continue
          }
          // 開始の無いタイ終端(Soundslice 書き出しの癖)。新しい音として扱う
          unterminated++
        }
        const pl: Placed = { q: qAbs, durQ: nn.durQ, pitch: nn.pitch, velocity: nn.velocity, grace: false, graceAfter: false, unit }
        placed.push(pl)
        if (nn.tieStart) openTies.set(tieKey, { pl, endQ: qAbs + nn.durQ })
      }
    }
    cursorQ += lenQ[mi]
  }
  unterminated += openTies.size

  // --- 5. 中間表現(tick ベース)にまとめる ---
  // 同じ位置に複数のテンポ記号がある場合(MuseScore の「rit.」が不可視のテンポ列として書き出される等)は
  // MuseScore の MIDI 書き出しと同じく最初のものを採用する(sort は安定なので同位置の順序は出現順のまま)
  const tempos = tempoEvents.sort((a, b) => a.q - b.q).filter((t, i, arr) => i === 0 || t.q !== arr[i - 1].q)

  // 装飾音は「単位 × 主音の位置」でグループにし、グループ内の順番を持たせる
  const graceGroups = new Map<string, Placed[]>()
  for (const pl of placed) {
    if (!pl.grace) continue
    const k = `${pl.unit}|${pl.q.toFixed(6)}`
    pushTo(graceGroups, k, pl)
  }
  const tlNotes: TimelineNote[] = []
  for (const pl of placed) {
    if (pl.grace) continue
    tlNotes.push({ q: pl.q, durQ: pl.durQ, pitch: pl.pitch, velocity: pl.velocity })
  }
  for (const group of graceGroups.values()) {
    group.forEach((g, i) => tlNotes.push({ q: g.q, durQ: 0, pitch: g.pitch, velocity: g.velocity, grace: { index: i, size: group.length, after: g.graceAfter } }))
  }
  tlNotes.sort((a, b) => a.q - b.q || a.pitch - b.pitch)

  const timeline: ScoreTimeline = { notes: tlNotes, measures: tlMeasures, tempos, fermatas: mergeFermatas(fermataRegions), totalQ: cursorQ }

  for (const u of units) {
    if (u.tabPitchChecked && u.tabPitchDeltaMode !== 0)
      parseWarnings.push({
        code: 'tab-pitch-mismatch',
        level: 'info',
        message: `${u.key}: TAB の弦・フレットから求めた音高が楽譜の音高と ${u.tabPitchDeltaMode} 半音ずれています(${u.tabPitchChecked} 音で確認)。音高は楽譜側を使っています`,
        count: u.tabPitchChecked,
      })
  }
  if (unterminated)
    parseWarnings.push({
      code: 'unterminated-ties',
      level: 'info',
      message: `開始の無いタイ終端 ${unterminated} 音を新しい音として扱いました`,
      count: unterminated,
    })
  if (jumpMarks.length)
    parseWarnings.push({
      code: 'unsupported-jump',
      level: 'warn',
      message: `反復指示(${jumpMarks.join(', ')})は展開していません。楽譜どおりの順序で並べています`,
      count: jumpMarks.length,
    })
  if (measureRepeats)
    parseWarnings.push({
      code: 'measure-repeat',
      level: 'warn',
      message: `小節反復記号(measure-repeat)${measureRepeats} 小節は未対応のため空になります`,
      count: measureRepeats,
    })
  if (arpeggiates)
    parseWarnings.push({
      code: 'arpeggiate',
      level: 'info',
      message: `アルペジオ記号のついた ${arpeggiates} 音は同時発音として扱いました`,
      count: arpeggiates,
    })
  if (ornaments)
    parseWarnings.push({
      code: 'ornament',
      level: 'info',
      message: `トレモロ・トリル等の装飾記号 ${ornaments} 箇所は 1 音として扱いました`,
      count: ornaments,
    })
  if (mismatches)
    parseWarnings.push({
      code: 'measure-length-mismatch',
      level: 'info',
      message: `拍子と長さが一致しない小節が ${mismatches} 小節あります(ピックアップ小節など。実際の長さを採用)`,
      count: mismatches,
    })

  const parseStats: ParseStats = {
    title,
    software,
    measureCount: base.length,
    hasRepeats,
    repeatsExpanded: doExpand && order.length > base.length,
    tiesMerged,
    unterminatedTies: unterminated,
    graceNotes: graceCount,
    graceDropped: keepGrace ? 0 : graceCount,
    tupletNotes,
    rests,
    measureLengthMismatches: mismatches,
    duplicateParts: units.filter((u) => u.duplicateOf).map((u) => u.key),
    arpeggiates,
    ornaments,
    measureRepeats,
    jumpMarks,
  }
  const render: RenderOptions = {
    bpm: opts.bpm && opts.bpm > 0 ? opts.bpm : undefined,
    fallbackBpm: opts.fallbackBpm ?? 100,
    graceMs: opts.graceMs ?? 70,
    fermataStretch: opts.fermataStretch ?? 2,
  }
  return finalize(timeline, units, parseWarnings, parseStats, render)
}

function mergeFermatas(regions: { s: number; e: number }[]): { s: number; e: number }[] {
  // 同じ開始位置の和音は 1 つに畳み、重なる区間は結合する
  const seen = new Set<string>()
  const out: { s: number; e: number }[] = []
  for (const r of regions) {
    const k = r.s.toFixed(6)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ s: r.s, e: r.e })
  }
  out.sort((a, b) => a.s - b.s)
  for (let k = 1; k < out.length; k++) {
    if (out[k].s < out[k - 1].e) {
      out[k - 1].e = Math.max(out[k - 1].e, out[k].e)
      out.splice(k, 1)
      k--
    }
  }
  return out
}

/** テンポマップとフェルマータから q → ms の関数を作る */
function makeQToMs(timeline: ScoreTimeline, render: RenderOptions): { qToMs: (q: number) => number; tempos: { q: number; bpm: number }[]; source: ScoreConversion['tempoSource'] } {
  let tempos = timeline.tempos
  let source: ScoreConversion['tempoSource'] = 'score'
  if (render.bpm) {
    tempos = [{ q: 0, bpm: render.bpm }]
    source = 'override'
  } else if (!tempos.length) {
    tempos = [{ q: 0, bpm: render.fallbackBpm }]
    source = 'default'
  } else if (tempos[0].q > 0) {
    tempos = [{ q: 0, bpm: tempos[0].bpm }, ...tempos]
  }
  const cum: { q: number; ms: number; bpm: number }[] = []
  let ms = 0
  for (let i = 0; i < tempos.length; i++) {
    if (i > 0) ms += (tempos[i].q - tempos[i - 1].q) * (60000 / tempos[i - 1].bpm)
    cum.push({ q: tempos[i].q, ms, bpm: tempos[i].bpm })
  }
  const qToMsBase = (q: number) => {
    let seg = cum[0]
    for (const c of cum) if (c.q <= q + 1e-9) seg = c
    return seg.ms + (q - seg.q) * (60000 / seg.bpm)
  }
  // フェルマータ: 該当区間 [s, e) を stretch 倍に伸ばし、それ以降を後ろへずらす
  const stretch = render.fermataStretch
  const fermatas = stretch !== 1 ? timeline.fermatas : []
  const qToMs = (q: number) => {
    let v = qToMsBase(q)
    for (const f of fermatas) {
      if (f.s >= q) break
      const upto = Math.min(q, f.e)
      v += (qToMsBase(upto) - qToMsBase(f.s)) * (stretch - 1)
    }
    return v
  }
  return { qToMs, tempos, source }
}

/** 中間表現を ms に展開し、統計・警告をまとめて ScoreConversion にする */
function finalize(timeline: ScoreTimeline, parts: ScorePart[], parseWarnings: ScoreWarning[], parseStats: ParseStats, render: RenderOptions): ScoreConversion {
  const { qToMs, tempos, source } = makeQToMs(timeline, render)

  const rendered: { note: NoteEvent; grace: boolean }[] = []
  for (const n of timeline.notes) {
    const note: NoteEvent = { pitch: n.pitch, startMs: 0, durationMs: 1 }
    if (n.velocity !== undefined) note.velocity = n.velocity
    if (n.grace) {
      const anchorMs = qToMs(n.q)
      // 前打音は主音の直前に個数ぶん遡って並べる。後打音(steal-time-previous)は前の主音の末尾から時間を借りるので、
      // 前の主音の終端(= anchor)の直前に並べる。どちらも「anchor の手前」に置く
      note.startMs = Math.round(anchorMs - (n.grace.size - n.grace.index) * render.graceMs)
      note.durationMs = render.graceMs
    } else {
      const s = qToMs(n.q)
      note.startMs = Math.round(s)
      note.durationMs = Math.max(1, Math.round(qToMs(n.q + n.durQ) - s))
    }
    rendered.push({ note, grace: !!n.grace })
  }
  rendered.sort((a, b) => a.note.startMs - b.note.startMs || a.note.pitch - b.note.pitch)
  const notes = rendered.map((r) => r.note)
  // 先頭の主音に前打音が付いていると負の時刻になるので、全体を後ろにずらして 0 ms から始める
  const shift = notes.length ? Math.max(0, -notes[0].startMs) : 0
  if (shift) for (const n of notes) n.startMs += shift

  const measures: PlayedMeasure[] = timeline.measures.map((m) => ({
    index: m.index,
    number: m.number,
    pass: m.pass,
    startMs: Math.round(qToMs(m.q)) + shift,
    endMs: Math.round(qToMs(m.q + m.lenQ)) + shift,
  }))

  // --- 音符由来の統計 ---
  let lo = Infinity
  let hi = -Infinity
  let below = 0
  let above = 0
  let chordNoteCount = 0
  let minIoi: number | null = null
  let prevStart = -1
  let run = 0
  const flushRun = () => {
    if (run > 1) chordNoteCount += run
  }
  for (const { note: n, grace } of rendered) {
    lo = Math.min(lo, n.pitch)
    hi = Math.max(hi, n.pitch)
    if (n.pitch < GUITAR_LOW) below++
    if (n.pitch > GUITAR_HIGH) above++
    if (grace) continue // 装飾音は和音・音間隔の統計に入れない
    if (n.startMs === prevStart) run++
    else {
      flushRun()
      if (prevStart >= 0) {
        const d = n.startMs - prevStart
        if (d > 0 && (minIoi === null || d < minIoi)) minIoi = d
      }
      prevStart = n.startMs
      run = 1
    }
  }
  flushRun()
  const durationMs = notes.reduce((a, n) => Math.max(a, n.startMs + n.durationMs), 0)
  const stats: ScoreStats = {
    ...parseStats,
    playedMeasureCount: timeline.measures.length,
    noteCount: notes.length,
    chordNoteCount,
    chordRatio: notes.length ? chordNoteCount / notes.length : 0,
    pitchRange: notes.length ? [lo, hi] : null,
    belowGuitarRange: below,
    aboveGuitarRange: above,
    minInterOnsetMs: minIoi,
    durationMs,
  }

  const warnings: ScoreWarning[] = [...parseWarnings]
  if (!notes.length) warnings.push({ code: 'empty', level: 'warn', message: '音符が 1 つもありません' })
  if (source === 'default')
    warnings.push({ code: 'no-tempo', level: 'warn', message: `楽譜にテンポ記号が無いため ${render.fallbackBpm} BPM として展開しました。演奏する BPM を指定してください` })
  if (below)
    warnings.push({
      code: 'variant-tuning',
      level: 'warn',
      message: `${below} 音がギターの最低音 E2 より低い音(最低 ${pitchToName(lo)})です。ドロップ D などの変則調弦の楽譜と思われます。音は残していますが、採譜側は E2 未満を拾いません`,
      count: below,
    })
  if (above)
    warnings.push({ code: 'above-range', level: 'warn', message: `${above} 音がギターの診断音域(〜E6)より高い音(最高 ${pitchToName(hi)})です`, count: above })
  if (notes.length >= 8 && stats.chordRatio >= CHORD_HEAVY_RATIO)
    warnings.push({
      code: 'chord-heavy',
      level: 'info',
      message: `和音の構成音が全体の ${Math.round(stats.chordRatio * 100)}% を占めます。和音は音符単位の診断の対象外です`,
      count: chordNoteCount,
    })
  if (minIoi !== null && minIoi < FAST_NOTE_MS)
    warnings.push({
      code: 'fast-notes',
      level: 'info',
      message: `最短の音間隔が ${minIoi} ms です(${FAST_NOTE_MS} ms 未満の速いパッセージは採譜精度が下がります)`,
    })

  return {
    notes,
    measures,
    tempoBpm: tempos[0].bpm,
    tempoSource: source,
    warnings,
    stats,
    parts,
    timeline,
    internal: { render, parseWarnings, parseStats },
  }
}

/**
 * 演奏順の小節 fromIdx〜toIdx(conv.measures のインデックス、両端含む)だけを切り出す。
 * 先頭が 0 ms になるよう時刻を詰め直し、テンポは切り出し開始時点で有効なものから始める。
 */
export function sliceMeasures(conv: ScoreConversion, fromIdx: number, toIdx: number): ScoreConversion {
  const tl = conv.timeline
  const n = tl.measures.length
  if (!n) return conv
  const from = Math.max(0, Math.min(n - 1, Math.floor(fromIdx)))
  const to = Math.max(from, Math.min(n - 1, Math.floor(toIdx)))
  const qs = tl.measures[from].q
  const qe = tl.measures[to].q + tl.measures[to].lenQ
  const eps = 1e-9
  const notes = tl.notes.filter((x) => x.q >= qs - eps && x.q < qe - eps).map((x) => ({ ...x, q: x.q - qs }))
  let bpmAtStart = tl.tempos.length ? tl.tempos[0].bpm : undefined
  for (const t of tl.tempos) if (t.q <= qs + eps) bpmAtStart = t.bpm
  const tempos: { q: number; bpm: number }[] = bpmAtStart === undefined ? [] : [{ q: 0, bpm: bpmAtStart }]
  for (const t of tl.tempos) if (t.q > qs + eps && t.q < qe - eps) tempos.push({ q: t.q - qs, bpm: t.bpm })
  const fermatas = tl.fermatas
    .filter((f) => f.e > qs + eps && f.s < qe - eps)
    .map((f) => ({ s: Math.max(0, f.s - qs), e: Math.min(qe, f.e) - qs }))
  const measures = tl.measures.slice(from, to + 1).map((m) => ({ ...m, q: m.q - qs }))
  const sliced: ScoreTimeline = { notes, measures, tempos, fermatas, totalQ: qe - qs }
  return finalize(sliced, conv.parts, conv.internal.parseWarnings, conv.internal.parseStats, conv.internal.render)
}

/**
 * BPM を変えて ms を再計算する。bpm に数値を渡すと一定テンポで展開(tempoSource 'override')、
 * 'score' を渡すと楽譜のテンポマップに戻す。
 */
export function retime(conv: ScoreConversion, bpm: number | 'score'): ScoreConversion {
  const render: RenderOptions = { ...conv.internal.render, bpm: typeof bpm === 'number' && bpm > 0 ? bpm : undefined }
  return finalize(conv.timeline, conv.parts, conv.internal.parseWarnings, conv.internal.parseStats, render)
}
