// 外部の音符起こし(MIDI 出力)を GAPS / GuitarSet の正解と照合して採点する。gaps-notes.mjs と同じ基準(±50ms・音高一致・オフセット無視)。
//   node eval/midi-score.mjs <data-dir> <midi-dir> [cropSec=60]
// <data-dir> は GAPS(midi/)でも GuitarSet(annotation/*.jams)でもよい。GuitarSet では comp / solo の内訳も出す
import fs from 'node:fs'
import path from 'node:path'
import { loadRefNotes, parseMidi, matchNotes, prf } from './gaps-score-lib.mjs'
const [,, DATA, DIR, CROP = '60'] = process.argv
const cropMs = Number(CROP) * 1000
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mid')).sort()
const agg = { all: [0, 0, 0], comp: [0, 0, 0], solo: [0, 0, 0] }; const rows = []
const bands = [[40, 51], [52, 63], [64, 127]]; const band = bands.map(() => [0, 0]); const dens = [[0, 0], [0, 0], [0, 0]]; const dur = [[0, 0], [0, 0], [0, 0]]
for (const f of files) {
  const id = f.replace('.mid', '')
  const ref = loadRefNotes(DATA, id).filter((n) => n.startMs < cropMs)
  const est = parseMidi(fs.readFileSync(path.join(DIR, f))).notes.filter((n) => n.startMs < cropMs)
  const m = matchNotes(ref, est, 50); const hit = matchNotes.lastMatchedRef
  ref.forEach((n, i) => { const h = hit.has(i) ? 1 : 0
    const b = bands.findIndex(([lo, hi]) => n.pitch >= lo && n.pitch <= hi); if (b >= 0) { band[b][0] += h; band[b][1]++ }
    const d = ref.filter((x) => Math.abs(x.startMs - n.startMs) <= 500).length; const dk = d <= 4 ? 0 : d <= 8 ? 1 : 2; dens[dk][0] += h; dens[dk][1]++
    const sk = n.durationMs <= 120 ? 0 : n.durationMs <= 300 ? 1 : 2; dur[sk][0] += h; dur[sk][1]++ })
  const add = (k) => { agg[k][0] += m; agg[k][1] += ref.length; agg[k][2] += est.length }
  add('all'); if (/_comp$/.test(id)) add('comp'); if (/_solo$/.test(id)) add('solo')
  rows.push({ id, ...prf(m, ref.length, est.length), nRef: ref.length, nEst: est.length })
}
const pct = (x) => (100 * x).toFixed(1)
const fmt = (k) => { const [m, nr, ne] = agg[k]; const r = prf(m, nr, ne); return `P=${pct(r.p)}% R=${pct(r.r)}% F1=${pct(r.f)}%  (正解${nr}音 / 予測${ne}音)` }
console.log(`${path.basename(DIR)}: ${files.length} 曲、各曲先頭 ${CROP}s、±50ms・音高一致・オフセット無視`)
console.log('全体 ' + fmt('all'))
if (agg.comp[1]) console.log('comp ' + fmt('comp')); if (agg.solo[1]) console.log('solo ' + fmt('solo'))
const labels = ['低音弦 E2-D#3', '中 E3-D#4', '高 E4-', '≤4音/秒', '5-8音/秒', '>8音/秒', '音価 ≤120ms', '120-300ms', '>300ms']
console.log('検出率の内訳: ' + [...band, ...dens, ...dur].map(([a, b], i) => `${labels[i]} ${(100 * a / b).toFixed(0)}%`).join('  '))
rows.sort((a, b) => a.f - b.f)
console.log(`曲別 F1 中央値 ${pct(rows[Math.floor(rows.length / 2)].f)}%、最低 ${rows[0].id} ${pct(rows[0].f)}%、最高 ${rows[rows.length - 1].id} ${pct(rows[rows.length - 1].f)}%`)
const t = path.join(DIR, 'timings.csv'); if (fs.existsSync(t)) { const rs = fs.readFileSync(t, 'utf8').trim().split('\n').map((l) => l.split(',').map(Number)); const a = rs.reduce((s, r) => s + r[1], 0), b = rs.reduce((s, r) => s + r[2], 0); console.log(`推論時間: 音声 ${a.toFixed(0)}s に対して ${b.toFixed(0)}s(実時間の ${(b / a).toFixed(2)} 倍)`) }
