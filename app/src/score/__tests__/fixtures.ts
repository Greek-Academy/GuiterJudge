// テスト用の小さな MusicXML を組み立てるヘルパ(自作フィクスチャ。外部データは使わない)。
// divisions は既定 4(四分音符 = 4)なので、四分 = 4、八分 = 2、十六分 = 1、二分 = 8。
import { parseXml } from './minidom.ts'
import { convertMusicXml, type ConvertOptions, type ScoreConversion } from '../musicxml.ts'

export type NoteOpts = {
  alter?: number
  chord?: boolean
  tie?: 'start' | 'stop' | 'both'
  /** <tie> ではなく <notations><tied> だけで書く(古い書き出し) */
  tiedOnly?: boolean
  voice?: number
  staff?: number
  grace?: boolean
  /** 後打音(steal-time-previous) */
  graceAfter?: boolean
  /** [actual, normal](3 連符なら [3, 2]) */
  tuplet?: [number, number]
  fermata?: boolean
  string?: number
  fret?: number
  arpeggiate?: boolean
  tremolo?: boolean
  dynamics?: number
  cue?: boolean
}

/** 音符。dur は divisions 単位 */
export function N(step: string, octave: number, dur: number, o: NoteOpts = {}): string {
  const parts: string[] = [o.dynamics !== undefined ? `<note dynamics="${o.dynamics}">` : '<note>']
  if (o.grace) parts.push(o.graceAfter ? '<grace steal-time-previous="50"/>' : '<grace/>')
  if (o.cue) parts.push('<cue/>')
  if (o.chord) parts.push('<chord/>')
  parts.push(`<pitch><step>${step}</step>${o.alter ? `<alter>${o.alter}</alter>` : ''}<octave>${octave}</octave></pitch>`)
  if (!o.grace) parts.push(`<duration>${dur}</duration>`)
  if (o.tie && !o.tiedOnly) {
    if (o.tie === 'stop' || o.tie === 'both') parts.push('<tie type="stop"/>')
    if (o.tie === 'start' || o.tie === 'both') parts.push('<tie type="start"/>')
  }
  parts.push(`<voice>${o.voice ?? 1}</voice>`)
  if (o.tuplet) parts.push(`<time-modification><actual-notes>${o.tuplet[0]}</actual-notes><normal-notes>${o.tuplet[1]}</normal-notes></time-modification>`)
  if (o.staff) parts.push(`<staff>${o.staff}</staff>`)
  const notations: string[] = []
  if (o.tie) {
    if (o.tie === 'stop' || o.tie === 'both') notations.push('<tied type="stop"/>')
    if (o.tie === 'start' || o.tie === 'both') notations.push('<tied type="start"/>')
  }
  if (o.fermata) notations.push('<fermata/>')
  if (o.arpeggiate) notations.push('<arpeggiate/>')
  if (o.tremolo) notations.push('<ornaments><tremolo type="single">3</tremolo></ornaments>')
  if (o.string !== undefined && o.fret !== undefined) notations.push(`<technical><string>${o.string}</string><fret>${o.fret}</fret></technical>`)
  if (notations.length) parts.push(`<notations>${notations.join('')}</notations>`)
  parts.push('</note>')
  return parts.join('')
}

export function REST(dur: number, o: { voice?: number; staff?: number; fermata?: boolean; measure?: boolean } = {}): string {
  return (
    `<note><rest${o.measure ? ' measure="yes"' : ''}/><duration>${dur}</duration><voice>${o.voice ?? 1}</voice>` +
    (o.staff ? `<staff>${o.staff}</staff>` : '') +
    (o.fermata ? '<notations><fermata/></notations>' : '') +
    '</note>'
  )
}

export const BACKUP = (dur: number) => `<backup><duration>${dur}</duration></backup>`
export const FORWARD = (dur: number) => `<forward><duration>${dur}</duration></forward>`

export type AttrOpts = {
  divisions?: number
  /** [beats, beatType] */
  time?: [number, number]
  staves?: number
  /** 譜表ごとの音部記号。'G' | 'F' | 'TAB' | 'G8vb'(clef-octave-change -1) */
  clefs?: string[]
  /** <transpose> の chromatic / octave-change(staff 指定は number 属性) */
  transpose?: { chromatic?: number; octaveChange?: number; staff?: number }
  /** 譜表番号 → 開放弦の MIDI(6 弦→1 弦の順) */
  tuning?: Record<number, number[]>
  measureRepeat?: boolean
}

const STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B']
const ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]

export function ATTRS(o: AttrOpts = {}): string {
  const parts: string[] = ['<attributes>']
  parts.push(`<divisions>${o.divisions ?? 4}</divisions>`)
  parts.push('<key><fifths>0</fifths></key>')
  if (o.time) parts.push(`<time><beats>${o.time[0]}</beats><beat-type>${o.time[1]}</beat-type></time>`)
  if (o.staves) parts.push(`<staves>${o.staves}</staves>`)
  if (o.clefs) {
    o.clefs.forEach((c, i) => {
      const n = o.clefs!.length > 1 ? ` number="${i + 1}"` : ''
      if (c === 'TAB') parts.push(`<clef${n}><sign>TAB</sign><line>5</line></clef>`)
      else if (c === 'G8vb') parts.push(`<clef${n}><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`)
      else if (c === 'F') parts.push(`<clef${n}><sign>F</sign><line>4</line></clef>`)
      else parts.push(`<clef${n}><sign>G</sign><line>2</line></clef>`)
    })
  }
  if (o.tuning) {
    for (const [staff, open] of Object.entries(o.tuning)) {
      const lines = open
        .map((midi, i) => {
          const pc = ((midi % 12) + 12) % 12
          const oct = Math.floor(midi / 12) - 1
          return `<staff-tuning line="${i + 1}"><tuning-step>${STEPS[pc]}</tuning-step>${ALTERS[pc] ? `<tuning-alter>${ALTERS[pc]}</tuning-alter>` : ''}<tuning-octave>${oct}</tuning-octave></staff-tuning>`
        })
        .join('')
      parts.push(`<staff-details number="${staff}"><staff-lines>${open.length}</staff-lines>${lines}</staff-details>`)
    }
  }
  if (o.transpose) {
    const n = o.transpose.staff ? ` number="${o.transpose.staff}"` : ''
    parts.push(
      `<transpose${n}>` +
        (o.transpose.chromatic !== undefined ? `<chromatic>${o.transpose.chromatic}</chromatic>` : '<chromatic>0</chromatic>') +
        (o.transpose.octaveChange !== undefined ? `<octave-change>${o.transpose.octaveChange}</octave-change>` : '') +
        '</transpose>',
    )
  }
  if (o.measureRepeat) parts.push('<measure-style><measure-repeat type="start">1</measure-repeat></measure-style>')
  parts.push('</attributes>')
  return parts.join('')
}

/** <direction> のテンポ。metronome か sound tempo */
export function TEMPO(bpm: number, o: { unit?: string; dotted?: boolean; sound?: boolean; words?: string } = {}): string {
  if (o.sound) return `<direction placement="above"><direction-type><words>${o.words ?? ''}</words></direction-type><sound tempo="${bpm}"/></direction>`
  return (
    '<direction placement="above">' +
    (o.words ? `<direction-type><words>${o.words}</words></direction-type>` : '') +
    `<direction-type><metronome><beat-unit>${o.unit ?? 'quarter'}</beat-unit>${o.dotted ? '<beat-unit-dot/>' : ''}<per-minute>${bpm}</per-minute></metronome></direction-type>` +
    '</direction>'
  )
}

export const WORDS = (s: string) => `<direction><direction-type><words>${s}</words></direction-type></direction>`

export type BarOpts = { repeat?: 'forward' | 'backward'; times?: number; ending?: { number: string; type: 'start' | 'stop' | 'discontinue' } }
export function BARLINE(o: BarOpts): string {
  const loc = o.repeat === 'forward' || o.ending?.type === 'start' ? 'left' : 'right'
  return (
    `<barline location="${loc}">` +
    (o.ending ? `<ending number="${o.ending.number}" type="${o.ending.type}"/>` : '') +
    (o.repeat ? `<repeat direction="${o.repeat}"${o.times ? ` times="${o.times}"` : ''}/>` : '') +
    '</barline>'
  )
}

export function MEASURE(number: number | string, body: string[], o: { implicit?: boolean } = {}): string {
  return `<measure number="${number}"${o.implicit ? ' implicit="yes"' : ''}>${body.join('')}</measure>`
}

export type PartSpec = { id: string; name?: string; measures: string[] }

export function SCORE(parts: PartSpec[], o: { software?: string; title?: string } = {}): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
    '<score-partwise version="4.0">' +
    (o.title ? `<work><work-title>${o.title}</work-title></work>` : '') +
    `<identification><encoding><software>${o.software ?? 'fixture'}</software></encoding></identification>` +
    `<part-list>${parts.map((p) => `<score-part id="${p.id}"><part-name>${p.name ?? p.id}</part-name></score-part>`).join('')}</part-list>` +
    parts.map((p) => `<part id="${p.id}">${p.measures.join('')}</part>`).join('') +
    '</score-partwise>'
  )
}

/** 1 パートだけの楽譜を作る(先頭小節に attributes とテンポを付ける) */
export function simpleScore(measures: string[][], o: { attrs?: AttrOpts; tempo?: string | null; software?: string } = {}): string {
  const head = [ATTRS({ time: [4, 4], clefs: ['G'], ...o.attrs }), ...(o.tempo === null ? [] : [o.tempo ?? TEMPO(120)])]
  return SCORE([{ id: 'P1', name: 'Guitar', measures: measures.map((m, i) => MEASURE(i + 1, i === 0 ? [...head, ...m] : m)) }], { software: o.software })
}

export function convert(xml: string, opts?: ConvertOptions): ScoreConversion {
  return convertMusicXml(parseXml(xml), opts)
}

/** 検証用に (pitch, startMs, durationMs) の 3 つ組へ */
export function triples(conv: ScoreConversion): [number, number, number][] {
  return conv.notes.map((n) => [n.pitch, n.startMs, n.durationMs])
}
