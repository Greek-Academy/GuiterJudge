/// <reference types="node" />
// タイの結合、反復・volta の展開、装飾音の配置
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sliceMeasures } from '../musicxml.ts'
import { ATTRS, BARLINE, MEASURE, N, REST, SCORE, TEMPO, convert, simpleScore, triples } from './fixtures.ts'

// --- タイ ---

test('小節をまたぐタイは 1 音に結合される(<tie> / <tied> どちらでも)', () => {
  for (const tiedOnly of [false, true]) {
    const conv = convert(simpleScore([[N('C', 4, 16, { tie: 'start', tiedOnly })], [N('C', 4, 8, { tie: 'stop', tiedOnly }), N('D', 4, 8)]]))
    assert.deepEqual(triples(conv), [
      [60, 0, 3000],
      [62, 3000, 1000],
    ])
    assert.equal(conv.stats.tiesMerged, 1)
    assert.equal(conv.stats.unterminatedTies, 0)
  }
})

test('タイの連鎖(start → stop+start → stop)は 1 音、和音のタイは音ごとに結合', () => {
  const conv = convert(
    simpleScore([
      [N('C', 4, 16, { tie: 'start' }), N('E', 4, 16, { chord: true, tie: 'start' })],
      [N('C', 4, 16, { tie: 'both' }), N('E', 4, 16, { chord: true, tie: 'stop' })],
      [N('C', 4, 16, { tie: 'stop' })],
    ]),
  )
  assert.deepEqual(triples(conv), [
    [60, 0, 6000],
    [64, 0, 4000],
  ])
  assert.equal(conv.stats.tiesMerged, 3)
})

test('開始の無いタイ終端は新しい音として扱い、info 警告に数える', () => {
  const conv = convert(simpleScore([[N('C', 4, 8, { tie: 'stop' }), N('D', 4, 8)]]))
  assert.deepEqual(triples(conv), [
    [60, 0, 1000],
    [62, 1000, 1000],
  ])
  assert.equal(conv.stats.unterminatedTies, 1)
  assert.ok(conv.warnings.some((w) => w.code === 'unterminated-ties' && w.count === 1))
})

test('声部が変わるタイも、同じ単位・同じ音高で終端が一致すれば結合される', () => {
  const conv = convert(simpleScore([[N('C', 4, 8, { voice: 1, tie: 'start' }), REST(8, { voice: 1 }), '<backup><duration>16</duration></backup>', REST(8, { voice: 2 }), N('C', 4, 8, { voice: 2, tie: 'stop' })]]))
  assert.deepEqual(triples(conv), [[60, 0, 2000]])
  assert.equal(conv.stats.tiesMerged, 1)
})

// --- 反復・volta ---

const head = [ATTRS({ time: [4, 4], clefs: ['G'] }), TEMPO(120)]
const whole = (step: string, oct = 4) => N(step, oct, 16)

test('反復記号 + 1 番・2 番括弧は演奏順に展開される(|: C D [1. E :| [2. F)', () => {
  const xml = SCORE([
    {
      id: 'P1',
      measures: [
        MEASURE(1, [...head, BARLINE({ repeat: 'forward' }), whole('C')]),
        MEASURE(2, [whole('D')]),
        MEASURE(3, [BARLINE({ ending: { number: '1', type: 'start' } }), whole('E'), BARLINE({ ending: { number: '1', type: 'stop' }, repeat: 'backward' })]),
        MEASURE(4, [BARLINE({ ending: { number: '2', type: 'start' } }), whole('F'), BARLINE({ ending: { number: '2', type: 'discontinue' } })]),
        MEASURE(5, [whole('G')]),
      ],
    },
  ])
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => [n.pitch, n.startMs]),
    [
      [60, 0],
      [62, 2000],
      [64, 4000],
      [60, 6000],
      [62, 8000],
      [65, 10000],
      [67, 12000],
    ],
  )
  assert.deepEqual(
    conv.measures.map((m) => [m.index, m.number, m.pass]),
    [
      [0, '1', 1],
      [1, '2', 1],
      [2, '3', 1],
      [0, '1', 2],
      [1, '2', 2],
      [3, '4', 1],
      [4, '5', 1],
    ],
  )
  assert.equal(conv.stats.measureCount, 5)
  assert.equal(conv.stats.playedMeasureCount, 7)
  assert.equal(conv.stats.hasRepeats, true)
  assert.equal(conv.stats.repeatsExpanded, true)

  const flat = convert(xml, { expandRepeats: false })
  assert.deepEqual(
    flat.notes.map((n) => n.pitch),
    [60, 62, 64, 65, 67],
  )
  assert.equal(flat.stats.playedMeasureCount, 5)
  assert.equal(flat.stats.repeatsExpanded, false)
  assert.equal(flat.stats.hasRepeats, true)
})

test('反復開始記号が無い戻りは曲頭へ。times 属性で回数を指定できる', () => {
  const mk = (times?: number) =>
    SCORE([{ id: 'P1', measures: [MEASURE(1, [...head, whole('C')]), MEASURE(2, [whole('D'), BARLINE({ repeat: 'backward', times })]), MEASURE(3, [whole('E')])] }])
  assert.deepEqual(
    convert(mk()).measures.map((m) => m.index),
    [0, 1, 0, 1, 2],
  )
  assert.deepEqual(
    convert(mk(3)).measures.map((m) => m.index),
    [0, 1, 0, 1, 0, 1, 2],
  )
})

test('「1, 2」括弧 + 「3」括弧: times 無しの反復回数は括弧番号の最大(3 回)になる', () => {
  const xml = SCORE([
    {
      id: 'P1',
      measures: [
        MEASURE(1, [...head, BARLINE({ repeat: 'forward' }), whole('C')]),
        MEASURE(2, [BARLINE({ ending: { number: '1, 2', type: 'start' } }), whole('D'), BARLINE({ ending: { number: '1, 2', type: 'stop' }, repeat: 'backward' })]),
        MEASURE(3, [BARLINE({ ending: { number: '3', type: 'start' } }), whole('E'), BARLINE({ ending: { number: '3', type: 'discontinue' } })]),
      ],
    },
  ])
  assert.deepEqual(
    convert(xml).measures.map((m) => m.index),
    [0, 1, 0, 1, 0, 2],
  )
})

test('2 つの反復ブロックが続く場合、2 番括弧の開始小節に次ブロックの反復開始が同居しても正しく回る', () => {
  const xml = SCORE([
    {
      id: 'P1',
      measures: [
        MEASURE(1, [...head, BARLINE({ repeat: 'forward' }), whole('C')]),
        MEASURE(2, [BARLINE({ ending: { number: '1', type: 'start' } }), whole('D'), BARLINE({ ending: { number: '1', type: 'stop' }, repeat: 'backward' })]),
        // 2 番括弧 = 次のブロックの反復開始
        MEASURE(3, [BARLINE({ ending: { number: '2', type: 'start' }, repeat: 'forward' }), whole('E'), BARLINE({ ending: { number: '2', type: 'stop' } })]),
        MEASURE(4, [whole('F'), BARLINE({ repeat: 'backward' })]),
        MEASURE(5, [whole('G')]),
      ],
    },
  ])
  assert.deepEqual(
    convert(xml).measures.map((m) => m.index),
    [0, 1, 0, 2, 3, 2, 3, 4],
  )
})

test('「1.」括弧が反復終端の 1 小節手前で閉じる譜面でも、括弧の外に残った小節を 1 回目の続きとして扱う', () => {
  const xml = SCORE([
    {
      id: 'P1',
      measures: [
        MEASURE(1, [...head, BARLINE({ repeat: 'forward' }), whole('C')]),
        MEASURE(2, [BARLINE({ ending: { number: '1', type: 'start' } }), whole('D'), BARLINE({ ending: { number: '1', type: 'stop' } })]),
        MEASURE(3, [whole('E'), BARLINE({ repeat: 'backward' })]),
        MEASURE(4, [BARLINE({ ending: { number: '2', type: 'start' } }), whole('F'), BARLINE({ ending: { number: '2', type: 'discontinue' } })]),
      ],
    },
  ])
  assert.deepEqual(
    convert(xml).measures.map((m) => m.index),
    [0, 1, 2, 0, 3],
  )
})

// --- 装飾音 ---

test('前打音は主音の直前に 70 ms ずつ遡って並び、grace: "drop" で除外できる', () => {
  const xml = simpleScore([[N('C', 4, 4), N('D', 4, 0, { grace: true }), N('F', 4, 0, { grace: true }), N('E', 4, 4), REST(8)]])
  const conv = convert(xml)
  assert.deepEqual(triples(conv), [
    [60, 0, 500],
    [62, 360, 70],
    [65, 430, 70],
    [64, 500, 500],
  ])
  assert.equal(conv.stats.graceNotes, 2)
  assert.equal(conv.stats.graceDropped, 0)
  // 装飾音は和音・最短音間隔の統計に入れない
  assert.equal(conv.stats.chordNoteCount, 0)
  assert.equal(conv.stats.minInterOnsetMs, 500)
  assert.ok(!conv.warnings.some((w) => w.code === 'fast-notes'))

  const dropped = convert(xml, { grace: 'drop' })
  assert.deepEqual(triples(dropped), [
    [60, 0, 500],
    [64, 500, 500],
  ])
  assert.equal(dropped.stats.graceDropped, 2)
  assert.equal(convert(xml, { graceMs: 50 }).notes[1].startMs, 400)
})

test('曲頭の前打音は負の時刻にならないよう全体を後ろにずらす(小節の開始も揃う)', () => {
  const conv = convert(simpleScore([[N('B', 3, 0, { grace: true }), N('C', 4, 4), REST(12)]]))
  assert.deepEqual(triples(conv), [
    [59, 0, 70],
    [60, 70, 500],
  ])
  assert.equal(conv.measures[0].startMs, 70)
})

test('後打音(steal-time-previous)は前の主音の終端の直前に置かれる', () => {
  const conv = convert(simpleScore([[N('C', 4, 4), N('D', 4, 0, { grace: true, graceAfter: true }), REST(4), N('E', 4, 4), REST(4)]]))
  assert.deepEqual(triples(conv), [
    [60, 0, 500],
    [62, 430, 70],
    [64, 1000, 500],
  ])
})

// --- sliceMeasures ---

test('sliceMeasures は演奏順の小節範囲を切り出して 0 ms から詰め直し、開始時点のテンポを引き継ぐ', () => {
  const xml = SCORE([
    { id: 'P1', measures: [MEASURE(1, [ATTRS({ time: [4, 4], clefs: ['G'] }), TEMPO(60), whole('C')]), MEASURE(2, [whole('D')]), MEASURE(3, [TEMPO(120), whole('E')]), MEASURE(4, [whole('F')])] },
  ])
  const conv = convert(xml)
  const sl = sliceMeasures(conv, 1, 2)
  assert.deepEqual(triples(sl), [
    [62, 0, 4000],
    [64, 4000, 2000],
  ])
  assert.deepEqual(sl.measures, [
    { index: 1, number: '2', pass: 1, startMs: 0, endMs: 4000 },
    { index: 2, number: '3', pass: 1, startMs: 4000, endMs: 6000 },
  ])
  assert.equal(sl.tempoBpm, 60)
  assert.equal(sl.tempoSource, 'score')
  assert.equal(sl.stats.playedMeasureCount, 2)
  assert.equal(sl.stats.measureCount, 4)
  assert.equal(sl.stats.durationMs, 6000)
  // 元は変わらない
  assert.equal(conv.notes.length, 4)
  // 範囲外は端に丸める
  assert.equal(sliceMeasures(conv, -5, 99).notes.length, 4)
  assert.equal(sliceMeasures(conv, 3, 3).notes[0].pitch, 65)
})

test('sliceMeasures は装飾音(主音の位置で判定)とフェルマータも範囲に合わせて持ち込む', () => {
  const xml = simpleScore([[N('C', 4, 16)], [N('D', 4, 0, { grace: true }), N('E', 4, 8, { fermata: true }), N('F', 4, 8)], [N('G', 4, 16)]])
  const sl = sliceMeasures(convert(xml), 1, 1)
  assert.deepEqual(triples(sl), [
    [62, 0, 70],
    [64, 70, 2000],
    [65, 2070, 1000],
  ])
  assert.equal(sl.measures.length, 1)
})
