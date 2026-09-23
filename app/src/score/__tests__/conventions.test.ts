/// <reference types="node" />
// 書き出し元ごとの記譜慣習 3 系統(Soundslice / MuseScore 4 / 旧 MuseScore)と、五線+TAB の重複除去、変則調弦
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTRS, MEASURE, N, REST, SCORE, TEMPO, convert } from './fixtures.ts'

const STANDARD = [40, 45, 50, 55, 59, 64] // E2 A2 D3 G3 B3 E4(6 弦 → 1 弦)
const DROP_D = [38, 45, 50, 55, 59, 64]

/** 開放弦 4 音(6・5・4・3 弦)を書く。octaveShift = 記譜のオクターブずらし、tab = string/fret を付ける */
function openStrings(octaveShift: number, o: { tab?: boolean; staff?: number } = {}): string[] {
  const src: [string, number, number][] = [
    ['E', 2, 6],
    ['A', 2, 5],
    ['D', 3, 4],
    ['G', 3, 3],
  ]
  return src.map(([s, oct, str]) => N(s, oct + octaveShift, 4, { staff: o.staff, ...(o.tab ? { string: str, fret: 0 } : {}) }))
}

test('Soundslice 型: 五線パート(記譜 +12、transpose chromatic -12)+ TAB パート → 五線を採用し、実音になる', () => {
  const xml = SCORE(
    [
      { id: 'P1', name: 'Nylon Guitar', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'], transpose: { chromatic: -12 } }), TEMPO(120), ...openStrings(1)])] },
      { id: 'P2', name: 'Nylon Guitar', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['TAB'], tuning: { 1: STANDARD } }), ...openStrings(0, { tab: true })])] },
    ],
    { software: 'Soundslice MusicXML exporter' },
  )
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => n.pitch),
    [40, 45, 50, 55],
  )
  assert.equal(conv.parts.length, 2)
  const [staff, tab] = conv.parts
  assert.equal(staff.key, 'P1/1')
  assert.equal(staff.chosen, true)
  assert.equal(staff.isTab, false)
  assert.equal(staff.transposeSemitones, -12)
  assert.equal(tab.key, 'P2/1')
  assert.equal(tab.isTab, true)
  assert.equal(tab.chosen, false)
  assert.equal(tab.duplicateOf, 'P1/1')
  assert.equal(tab.tabPitchDeltaMode, 0)
  assert.equal(tab.tabPitchChecked, 4)
  assert.deepEqual(conv.stats.duplicateParts, ['P2/1'])
  assert.equal(conv.stats.belowGuitarRange, 0)
  assert.ok(!conv.warnings.some((w) => w.code === 'octave-duplicate' || w.code === 'tab-pitch-mismatch'))
})

test('MuseScore 4 型: 1 パート 2 譜表(五線は clef-octave-change -1 で実音、2 譜表目が TAB)→ 譜表 2 を重複として除く', () => {
  const attrs = ATTRS({ time: [4, 4], staves: 2, clefs: ['G8vb', 'TAB'], tuning: { 2: STANDARD } })
  const xml = SCORE([{ id: 'P1', name: 'Guitar', measures: [MEASURE(1, [attrs, TEMPO(120), ...openStrings(0, { staff: 1 }), '<backup><duration>16</duration></backup>', ...openStrings(0, { staff: 2, tab: true })])] }], {
    software: 'MuseScore Studio 4.7.5',
  })
  const conv = convert(xml)
  // clef-octave-change は見た目だけなので加算しない
  assert.deepEqual(
    conv.notes.map((n) => n.pitch),
    [40, 45, 50, 55],
  )
  assert.deepEqual(
    conv.parts.map((p) => [p.key, p.isTab, p.chosen, p.duplicateOf, p.clefOctaveChange]),
    [
      ['P1/1', false, true, undefined, -1],
      ['P1/2', true, false, 'P1/1', 0],
    ],
  )
})

test('MuseScore 4 が Soundslice 譜を再書き出した形(transpose octave-change -1、chromatic 0)も実音になる', () => {
  const xml = SCORE([{ id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'], transpose: { chromatic: 0, octaveChange: -1 } }), TEMPO(120), ...openStrings(1)])] }])
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => n.pitch),
    [40, 45, 50, 55],
  )
  assert.equal(conv.parts[0].transposeSemitones, -12)
})

test('旧 MuseScore 型: TAB のみ、staff-tuning が記譜(+12)→ 音高は <pitch> を使い、tuning とのずれは info 警告', () => {
  const tuningWritten = STANDARD.map((m) => m + 12)
  const xml = SCORE([{ id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['TAB'], tuning: { 1: tuningWritten } }), TEMPO(120), ...openStrings(0, { tab: true })])] }], { software: 'MuseScore 0.7' })
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => n.pitch),
    [40, 45, 50, 55],
  )
  assert.equal(conv.parts[0].isTab, true)
  assert.equal(conv.parts[0].chosen, true)
  assert.equal(conv.parts[0].tabPitchDeltaMode, 12)
  const w = conv.warnings.find((w) => w.code === 'tab-pitch-mismatch')
  assert.ok(w)
  assert.equal(w.level, 'info')
  assert.match(w.message, /12 半音/)
})

test('五線側の transpose が欠けてオクターブ違いで重複する場合、tuning 照合の取れた TAB 側を採用して警告する', () => {
  const xml = SCORE([
    { id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'] }), TEMPO(120), ...openStrings(1)])] }, // transpose 無し → 52, 57, ...
    { id: 'P2', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['TAB'], tuning: { 1: STANDARD } }), ...openStrings(0, { tab: true })])] },
  ])
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => n.pitch),
    [40, 45, 50, 55],
  )
  assert.equal(conv.parts[0].duplicateOf, 'P2/1')
  assert.equal(conv.parts[1].chosen, true)
  const w = conv.warnings.find((w) => w.code === 'octave-duplicate')
  assert.ok(w)
  assert.match(w.message, /TAB 側/)
})

test('音数が極少(4 音未満)の単位はオクターブ違いの重複判定をしない(ピアノ的 2 譜表の誤判定を防ぐ)', () => {
  const xml = SCORE([
    { id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], staves: 2, clefs: ['G', 'F'] }), TEMPO(120), N('C', 4, 16, { staff: 1 }), '<backup><duration>16</duration></backup>', N('C', 3, 16, { staff: 2 })])] },
  ])
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => n.pitch),
    [48, 60],
  )
  assert.equal(conv.parts.filter((p) => p.chosen).length, 2)
  assert.ok(!conv.warnings.some((w) => w.code === 'octave-duplicate'))
})

test('合奏譜: 音符集合が違うパートは重複とみなさず両方残す', () => {
  const xml = SCORE([
    { id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'] }), TEMPO(120), ...openStrings(1)])] },
    { id: 'P2', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'] }), N('C', 5, 16)])] },
  ])
  const conv = convert(xml)
  assert.equal(conv.parts.filter((p) => p.chosen).length, 2)
  assert.equal(conv.notes.length, 5)
})

test('ドロップ D: E2 より低い音は落とさず、variant-tuning 警告で知らせる', () => {
  const xml = SCORE(
    [
      { id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'], transpose: { chromatic: -12 } }), TEMPO(120), N('D', 3, 8), N('A', 3, 8)])] },
      { id: 'P2', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['TAB'], tuning: { 1: DROP_D } }), N('D', 2, 8, { string: 6, fret: 0 }), N('A', 2, 8, { string: 5, fret: 0 })])] },
    ],
    { software: 'Soundslice MusicXML exporter' },
  )
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => n.pitch),
    [38, 45],
  )
  assert.equal(conv.stats.belowGuitarRange, 1)
  assert.deepEqual(conv.stats.pitchRange, [38, 45])
  const w = conv.warnings.find((w) => w.code === 'variant-tuning')
  assert.ok(w)
  assert.equal(w.level, 'warn')
  assert.equal(w.count, 1)
  assert.match(w.message, /D2/)
  assert.match(w.message, /ドロップ D/)
  assert.match(w.message, /取り込むとこのスレッドの最低音を D2 に下げ/)
  assert.doesNotMatch(w.message, /拾いません|拾えません/)
})

test('variant-tuning: B1 より低い音は最低音を B1 までしか下げられないことも添える', () => {
  const conv = convert(SCORE([{ id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['F'] }), TEMPO(120), N('A', 1, 8), N('E', 2, 8)])] }]))
  const w = conv.warnings.find((w) => w.code === 'variant-tuning')
  assert.ok(w)
  assert.match(w.message, /最低 A1/)
  assert.match(w.message, /最低音を B1 に下げ/)
  assert.match(w.message, /B1 より低い音は拾えません/)
})

test('音域の上側(MIDI 88 超)も警告になる', () => {
  const conv = convert(SCORE([{ id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'] }), TEMPO(120), N('C', 7, 8), REST(8)])] }]))
  assert.equal(conv.notes[0].pitch, 96)
  assert.equal(conv.stats.aboveGuitarRange, 1)
  assert.ok(conv.warnings.some((w) => w.code === 'above-range'))
})
