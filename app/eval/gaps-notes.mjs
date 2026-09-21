// GAPS(クラシックギター実録音 + 演奏に合わせた MIDI)で Basic Pitch の音符起こしを採点する。
//
// 1) 音符起こしはブラウザ内の本番コード(transcribe())で行う。eval/gaps-harness の手順で
//    ヘッドレス Chrome に載せて回し、曲ごとの JSON({noteEvents, merged, analysisOffsetMs, ...})を得る。
// 2) このスクリプトがその JSON と midi/<id>.mid を突き合わせる。
//    採点は mir_eval の note 指標と同じ考え方: オンセット差が許容値以内かつ音高一致で1対1に対応付け、
//    precision / recall / F1 を出す(オフセットは見ない)。
//
//   node app/eval/gaps-notes.mjs <gaps-dir> <results-dir> [cropSec=60]
import fs from 'node:fs'
import path from 'node:path'
import { parseMidi, matchNotes, prf } from './gaps-score-lib.mjs'

const [,, DATA, RES, CROP = '60'] = process.argv
const cropMs = Number(CROP) * 1000

// --- 全体オフセットの推定: 予測を -1500..+1500ms ずらして一致数が最大になる点 ---
function bestShift(ref, est, tolMs) {
  let best = { shift: 0, m: -1 }
  for (let s = -1500; s <= 1500; s += 25) { const m = matchNotes(ref, est.map((e) => ({ ...e, startMs: e.startMs + s })), tolMs); if (m > best.m) best = { shift: s, m } }
  return best
}

const files = fs.readdirSync(RES).filter((f) => f.endsWith('.json')).sort()
const agg = { raw50: [0, 0, 0], merged50: [0, 0, 0], merged100: [0, 0, 0], merged50oct: [0, 0, 0], merged50shift: [0, 0, 0] }
const rowsOut = []
// 取りこぼしの内訳: 音高帯(低音弦 E2〜E3 / 中 / 高 E4〜)と、周囲の音の密度(前後1秒の正解音数)で分ける
const bands = [{ name: 'E2-D#3 (40-51)', lo: 40, hi: 51 }, { name: 'E3-D#4 (52-63)', lo: 52, hi: 63 }, { name: 'E4-  (64-)', lo: 64, hi: 127 }]
const bandTally = bands.map(() => [0, 0])
const densTally = { '<=4音/秒': [0, 0], '5-8音/秒': [0, 0], '>8音/秒': [0, 0] }
const shortTally = { '<=120ms': [0, 0], '120-300ms': [0, 0], '>300ms': [0, 0] }
for (const f of files) {
  const id = f.replace('.json', '')
  const res = JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8'))
  const midi = parseMidi(fs.readFileSync(path.join(DATA, 'midi', id + '.mid')))
  const ref = midi.notes.filter((n) => n.startMs < cropMs)
  const off = res.analysisOffsetMs
  const raw = res.noteEvents.map((n) => ({ ...n, startMs: n.startMs + off }))
  const merged = res.merged.map((n) => ({ ...n, startMs: n.startMs + off }))
  const m50raw = matchNotes(ref, raw, 50), m50 = matchNotes(ref, merged, 50)
  const matchedRef = matchNotes.lastMatchedRef
  ref.forEach((n, i) => {
    const hit = matchedRef.has(i) ? 1 : 0
    const b = bands.findIndex((bd) => n.pitch >= bd.lo && n.pitch <= bd.hi)
    if (b >= 0) { bandTally[b][0] += hit; bandTally[b][1]++ }
    const dens = ref.filter((o) => Math.abs(o.startMs - n.startMs) <= 500).length
    const dk = dens <= 4 ? '<=4音/秒' : dens <= 8 ? '5-8音/秒' : '>8音/秒'
    densTally[dk][0] += hit; densTally[dk][1]++
    const sk = n.durationMs <= 120 ? '<=120ms' : n.durationMs <= 300 ? '120-300ms' : '>300ms'
    shortTally[sk][0] += hit; shortTally[sk][1]++
  })
  const m100 = matchNotes(ref, merged, 100), m50oct = matchNotes(ref, merged, 50, true)
  const shift = bestShift(ref, merged, 50)
  const add = (k, m, nr, ne) => { agg[k][0] += m; agg[k][1] += nr; agg[k][2] += ne }
  add('raw50', m50raw, ref.length, raw.length); add('merged50', m50, ref.length, merged.length); add('merged100', m100, ref.length, merged.length); add('merged50oct', m50oct, ref.length, merged.length); add('merged50shift', shift.m, ref.length, merged.length)
  const r = prf(m50, ref.length, merged.length)
  rowsOut.push({ id, nRef: ref.length, nEst: merged.length, f: r.f, p: r.p, r: r.r, fOct: prf(m50oct, ref.length, merged.length).f, shift: shift.shift, fShift: prf(shift.m, ref.length, merged.length).f, suppressed: res.suppressedHarmonicCount, infer: res.timings?.inferenceMs })
}
const fmt = (k) => { const [m, nr, ne] = agg[k]; const r = prf(m, nr, ne); return `P=${(100 * r.p).toFixed(1)}% R=${(100 * r.r).toFixed(1)}% F1=${(100 * r.f).toFixed(1)}%  (正解${nr}音 / 予測${ne}音)` }
console.log(`GAPS test: ${files.length} 曲、各曲先頭 ${CROP}s`)
console.log('\n## 音符レベル(オンセット許容 ±50ms、音高一致、オフセット無視)')
console.log('分割統合前          ', fmt('raw50'))
console.log('分割統合後(診断入力)', fmt('merged50'))
console.log('\n## 切り分け')
console.log('許容 ±100ms         ', fmt('merged100'))
console.log('オクターブ違いを許容 ', fmt('merged50oct'))
console.log('曲ごとに最適シフト  ', fmt('merged50shift'), ' ← これが ±50ms と大差なら MIDI と音声の時間軸は揃っている')
console.log('\n## 曲別(分割統合後、F1 昇順)')
rowsOut.sort((a, b) => a.f - b.f)
for (const r of rowsOut) console.log(`${r.id}  F1=${(100 * r.f).toFixed(0).padStart(3)}%  P=${(100 * r.p).toFixed(0).padStart(3)}% R=${(100 * r.r).toFixed(0).padStart(3)}%  oct-tol F1=${(100 * r.fOct).toFixed(0).padStart(3)}%  shift=${String(r.shift).padStart(5)}ms(F1 ${(100 * r.fShift).toFixed(0)}%)  ref=${String(r.nRef).padStart(4)} est=${String(r.nEst).padStart(4)}  倍音除外=${r.suppressed}`)
console.log('\n## 取りこぼしの内訳(正解音のうち検出できた割合 = 再現率、±50ms・分割統合後)')
bands.forEach((b, i) => console.log(`音高 ${b.name.padEnd(16)} ${(100 * bandTally[i][0] / bandTally[i][1]).toFixed(1)}%  (${bandTally[i][1]}音)`))
for (const [k, v] of Object.entries(densTally)) console.log(`密度 ${k.padEnd(16)} ${(100 * v[0] / v[1]).toFixed(1)}%  (${v[1]}音)`)
for (const [k, v] of Object.entries(shortTally)) console.log(`音価 ${k.padEnd(16)} ${(100 * v[0] / v[1]).toFixed(1)}%  (${v[1]}音)`)
const med = rowsOut.map((r) => r.f).sort((a, b) => a - b)[Math.floor(rowsOut.length / 2)]
console.log(`\n曲別 F1 中央値 ${(100 * med).toFixed(1)}%、推論時間 合計 ${(rowsOut.reduce((a, r) => a + (r.infer || 0), 0) / 1000).toFixed(0)}s`)
