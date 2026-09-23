/// <reference types="node" />
// 基本の時間展開: 音符・休符・和音・連符・テンポ変更・フェルマータ・多声部・ピックアップ小節・retime
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retime } from '../musicxml.ts'
import { ATTRS, BACKUP, MEASURE, N, REST, SCORE, TEMPO, WORDS, convert, simpleScore, triples } from './fixtures.ts'

// divisions 4、4/4、120 BPM(四分 = 500 ms)が simpleScore の既定

test('四分音符と休符が 120 BPM で 500 ms 刻みに並ぶ', () => {
  const conv = convert(simpleScore([[N('C', 4, 4), N('D', 4, 4), REST(4), N('E', 4, 4)]]))
  assert.deepEqual(triples(conv), [
    [60, 0, 500],
    [62, 500, 500],
    [64, 1500, 500],
  ])
  assert.equal(conv.tempoBpm, 120)
  assert.equal(conv.tempoSource, 'score')
  assert.deepEqual(conv.measures, [{ index: 0, number: '1', pass: 1, startMs: 0, endMs: 2000 }])
  assert.equal(conv.stats.rests, 1)
  assert.equal(conv.stats.noteCount, 3)
  assert.equal(conv.stats.durationMs, 2000)
  assert.deepEqual(conv.stats.pitchRange, [60, 64])
  assert.equal(conv.stats.software, 'fixture')
  // velocity 指定が無い音には velocity キー自体を付けない
  assert.equal('velocity' in conv.notes[0], false)
})

test('小節をまたぐ位置は小節長(拍子)で積み上がる。全休符の小節も長さを持つ', () => {
  const conv = convert(simpleScore([[N('C', 4, 16)], [REST(16, { measure: true })], [N('D', 4, 16)]]))
  assert.deepEqual(triples(conv), [
    [60, 0, 2000],
    [62, 4000, 2000],
  ])
  assert.equal(conv.measures.length, 3)
  assert.equal(conv.measures[2].startMs, 4000)
})

test('<chord/> は直前の音と同じ開始時刻になり、和音の統計に数えられる', () => {
  const conv = convert(simpleScore([[N('C', 4, 8), N('E', 4, 8, { chord: true }), N('G', 4, 8, { chord: true }), N('A', 4, 8)]]))
  assert.deepEqual(triples(conv), [
    [60, 0, 1000],
    [64, 0, 1000],
    [67, 0, 1000],
    [69, 1000, 1000],
  ])
  assert.equal(conv.stats.chordNoteCount, 3)
  assert.equal(conv.stats.chordRatio, 0.75)
  assert.equal(conv.stats.minInterOnsetMs, 1000)
})

test('連符は <duration> が実効長なので特別処理なしで拍が合う(3 連 8 分)', () => {
  // divisions 6: 四分 = 6、3 連 8 分 = 2
  const trip = (s: string) => N(s, 4, 2, { tuplet: [3, 2] })
  const conv = convert(simpleScore([[trip('C'), trip('D'), trip('E'), N('F', 4, 6), N('G', 4, 6), N('A', 4, 6)]], { attrs: { divisions: 6 } }))
  assert.deepEqual(
    conv.notes.map((n) => n.startMs),
    [0, 167, 333, 500, 1000, 1500],
  )
  assert.deepEqual(
    conv.notes.map((n) => n.durationMs),
    [167, 167, 167, 500, 500, 500],
  )
  assert.equal(conv.stats.tupletNotes, 3)
  assert.equal(conv.stats.measureLengthMismatches, 0)
})

test('テンポ変更: metronome と <sound tempo>、付点 beat-unit、小節途中の変更', () => {
  const m1 = [N('C', 4, 4), N('D', 4, 4), N('E', 4, 4), N('F', 4, 4)] // 60 BPM → 1000 ms 刻み
  const m2 = [TEMPO(120, { sound: true }), N('G', 4, 4), TEMPO(60), N('A', 4, 4), N('B', 4, 8)] // 120 → 60 に小節途中で戻す
  const m3 = [TEMPO(40, { unit: 'half', dotted: true, words: 'Allegro' }), N('C', 5, 16)] // 付点 2 分 = 40 → 四分 120
  const conv = convert(simpleScore([m1, m2, m3], { tempo: TEMPO(60) }))
  assert.deepEqual(
    conv.notes.map((n) => n.startMs),
    [0, 1000, 2000, 3000, 4000, 4500, 5500, 7500],
  )
  assert.deepEqual(
    conv.notes.map((n) => n.durationMs),
    [1000, 1000, 1000, 1000, 500, 1000, 2000, 2000],
  )
  assert.equal(conv.tempoBpm, 60)
  assert.deepEqual(
    conv.timeline.tempos.map((t) => [t.q, t.bpm]),
    [
      [0, 60],
      [4, 120],
      [5, 60],
      [8, 120],
    ],
  )
})

test('同じ位置に複数のテンポ記号があれば最初のものを採用する(MuseScore の MIDI 書き出しと同じ)', () => {
  const conv = convert(simpleScore([[TEMPO(60), TEMPO(30), N('C', 4, 4)]], { tempo: null }))
  assert.equal(conv.tempoBpm, 60)
  assert.equal(conv.notes[0].durationMs, 1000)
})

test('テンポ記号が無ければ既定 100 BPM と no-tempo 警告。bpm 指定なら override', () => {
  const xml = simpleScore([[N('C', 4, 4)]], { tempo: null })
  const conv = convert(xml)
  assert.equal(conv.tempoSource, 'default')
  assert.equal(conv.tempoBpm, 100)
  assert.equal(conv.notes[0].durationMs, 600)
  assert.ok(conv.warnings.some((w) => w.code === 'no-tempo'))

  const fixed = convert(xml, { bpm: 60 })
  assert.equal(fixed.tempoSource, 'override')
  assert.equal(fixed.notes[0].durationMs, 1000)
  assert.ok(!fixed.warnings.some((w) => w.code === 'no-tempo'))
})

test('retime は tick ベースの中間表現から ms を再計算し、"score" で楽譜テンポに戻せる', () => {
  const conv = convert(simpleScore([[N('C', 4, 4), N('D', 4, 4), REST(8)], [TEMPO(60), N('E', 4, 8), REST(8)]]))
  assert.deepEqual(triples(conv), [
    [60, 0, 500],
    [62, 500, 500],
    [64, 2000, 2000],
  ])
  const fast = retime(conv, 240)
  assert.equal(fast.tempoSource, 'override')
  assert.equal(fast.tempoBpm, 240)
  assert.deepEqual(triples(fast), [
    [60, 0, 250],
    [62, 250, 250],
    [64, 1000, 500],
  ])
  assert.deepEqual(
    fast.measures.map((m) => [m.startMs, m.endMs]),
    [
      [0, 1000],
      [1000, 2000],
    ],
  )
  assert.equal(fast.stats.durationMs, 1500)
  assert.equal(fast.stats.measureLengthMismatches, 0)
  // 元の変換は変更されていない(不変)
  assert.equal(conv.notes[2].startMs, 2000)
  const back = retime(fast, 'score')
  assert.equal(back.tempoSource, 'score')
  assert.deepEqual(triples(back), triples(conv))
})

test('フェルマータは該当区間を 2 倍に伸ばし、後続をずらす。fermataStretch: 1 で無視。休符にも効く', () => {
  const xml = simpleScore([[N('C', 4, 4, { fermata: true }), N('D', 4, 4), REST(4, { fermata: true }), N('E', 4, 4)]])
  assert.deepEqual(triples(convert(xml)), [
    [60, 0, 1000],
    [62, 1000, 500],
    [64, 2500, 500],
  ])
  assert.deepEqual(triples(convert(xml, { fermataStretch: 1 })), [
    [60, 0, 500],
    [62, 500, 500],
    [64, 1500, 500],
  ])
})

test('多声部(backup)は同じ小節内で重なる。声部が違ってもタイは終端一致で結合される', () => {
  const m = [N('C', 4, 8, { voice: 1 }), N('D', 4, 8, { voice: 1 }), BACKUP(16), N('E', 3, 4, { voice: 2 }), N('E', 3, 4, { voice: 2 }), N('E', 3, 4, { voice: 2 }), N('E', 3, 4, { voice: 2 })]
  const conv = convert(simpleScore([m]))
  assert.deepEqual(triples(conv), [
    [52, 0, 500],
    [60, 0, 1000],
    [52, 500, 500],
    [52, 1000, 500],
    [62, 1000, 1000],
    [52, 1500, 500],
  ])
})

test('ピックアップ小節(implicit)は実際の長さ、拍子と合わない通常小節は mismatch として数える', () => {
  const head = [ATTRS({ time: [4, 4], clefs: ['G'] }), TEMPO(120)]
  const xml = SCORE([
    {
      id: 'P1',
      measures: [MEASURE(0, [...head, N('G', 3, 4)], { implicit: true }), MEASURE(1, [N('C', 4, 16)]), MEASURE(2, [N('D', 4, 8)]), MEASURE(3, [N('E', 4, 16)])],
    },
  ])
  const conv = convert(xml)
  assert.deepEqual(
    conv.notes.map((n) => n.startMs),
    [0, 500, 2500, 3500],
  )
  assert.equal(conv.stats.measureLengthMismatches, 1)
  assert.ok(conv.warnings.some((w) => w.code === 'measure-length-mismatch' && w.count === 1))
  assert.deepEqual(
    conv.measures.map((m) => m.number),
    ['0', '1', '2', '3'],
  )
})

test('dynamics 属性(フォルテ = 100%)は velocity(0.1〜1)になる。cue 音符は時間だけ進める', () => {
  const conv = convert(simpleScore([[N('C', 4, 4, { dynamics: 100 }), N('D', 4, 4, { cue: true }), N('E', 4, 4, { dynamics: 50 }), REST(4)]]))
  assert.equal(conv.notes.length, 2)
  assert.ok(Math.abs((conv.notes[0].velocity ?? 0) - 90 / 127) < 1e-9)
  assert.equal(conv.notes[1].startMs, 1000)
  assert.ok(Math.abs((conv.notes[1].velocity ?? 0) - 45 / 127) < 1e-9)
})

test('未対応要素は警告になる: D.C./D.S. の words、measure-repeat、arpeggiate、tremolo', () => {
  const conv = convert(
    simpleScore([
      [N('C', 4, 8, { arpeggiate: true }), N('E', 4, 8, { chord: true, arpeggiate: true }), N('G', 4, 8, { tremolo: true }), WORDS('D.S. al Coda')],
      [ATTRS({ measureRepeat: true }), REST(16, { measure: true })],
    ]),
  )
  const codes = conv.warnings.map((w) => w.code)
  assert.ok(codes.includes('unsupported-jump'))
  assert.ok(codes.includes('measure-repeat'))
  assert.ok(codes.includes('arpeggiate'))
  assert.ok(codes.includes('ornament'))
  assert.deepEqual(conv.stats.jumpMarks, ['D.S. al Coda'])
  assert.equal(conv.stats.arpeggiates, 2)
  assert.equal(conv.stats.ornaments, 1)
  assert.equal(conv.stats.measureRepeats, 1)
})

test('score-timewise と MusicXML 以外は Error', () => {
  assert.throws(() => convert('<?xml version="1.0"?><score-timewise><part id="P1"/></score-timewise>'), /score-timewise/)
  assert.throws(() => convert('<?xml version="1.0"?><html><body/></html>'), /score-partwise/)
  assert.throws(() => convert('<?xml version="1.0"?><score-partwise><part-list/></score-partwise>'), /パート/)
})

test('音符が無い楽譜は empty 警告', () => {
  const conv = convert(simpleScore([[REST(16, { measure: true })]]))
  assert.equal(conv.notes.length, 0)
  assert.ok(conv.warnings.some((w) => w.code === 'empty'))
  assert.equal(conv.stats.pitchRange, null)
})
