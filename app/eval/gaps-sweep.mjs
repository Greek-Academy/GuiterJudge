// 閾値スイープの採点。gaps-drive.mjs --sweep の出力(曲ごとに onset × frame の各組の音符列)を MIDI と照合し、
// グリッド全体の P/R/F1 を出す。複数の結果ディレクトリ(元モデル / ファインチューニング後)を並べて比較できる。
//   node eval/gaps-sweep.mjs <gaps-dir> <results-dir> [<results-dir> ...]
// 採点は gaps-notes.mjs の「分割統合後・±50ms・音高一致」と同じ。cropSec は各ディレクトリの grid.json から取る
import fs from 'node:fs'
import path from 'node:path'
import { parseMidi, matchNotes, prf } from './gaps-score-lib.mjs'

const [,, DATA, ...DIRS] = process.argv
if (!DATA || !DIRS.length) { console.error('usage: node eval/gaps-sweep.mjs <gaps-dir> <results-dir>...'); process.exit(1) }
const midiCache = new Map()
const refNotes = (id, cropMs) => {
  if (!midiCache.has(id)) midiCache.set(id, parseMidi(fs.readFileSync(path.join(DATA, 'midi', id + '.mid'))).notes)
  return midiCache.get(id).filter((n) => n.startMs < cropMs)
}
const pct = (x) => (100 * x).toFixed(1).padStart(5)

function scoreDir(dir) {
  const grid = JSON.parse(fs.readFileSync(path.join(dir, 'grid.json'), 'utf8'))
  const cropMs = grid.cropSec * 1000
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.json$/.test(f)).sort()
  const agg = new Map() // "onset/frame" -> [matched, nRef, nEst, perSongF1[]]
  const key = (o, f) => `${o}/${f}`
  for (const f of files) {
    const id = f.replace('.json', '')
    const res = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const ref = refNotes(id, cropMs)
    for (const c of res.cells) {
      const est = c.notes.map(([pitch, startMs, durationMs]) => ({ pitch, startMs: startMs + res.analysisOffsetMs, durationMs }))
      const m = matchNotes(ref, est, 50)
      const a = agg.get(key(c.onset, c.frame)) ?? [0, 0, 0, []]
      a[0] += m; a[1] += ref.length; a[2] += est.length; a[3].push(prf(m, ref.length, est.length).f)
      agg.set(key(c.onset, c.frame), a)
    }
  }
  const cells = [...agg.entries()].map(([k, [m, nr, ne, fs]]) => { const [o, f] = k.split('/').map(Number); return { onset: o, frame: f, ...prf(m, nr, ne), nRef: nr, nEst: ne, medF: fs.sort((a, b) => a - b)[Math.floor(fs.length / 2)] } })
  return { grid, files, cells }
}

const results = DIRS.map((d) => ({ dir: d, ...scoreDir(d) }))
for (const r of results) {
  const name = path.basename(r.dir)
  console.log(`\n=== ${name}: ${r.files.length} 曲、各曲先頭 ${r.grid.cropSec}s、分割統合後・±50ms・音高一致 ===`)
  console.log('F1(%)  行=onset 列=frame')
  console.log('       ' + r.grid.frames.map((f) => String(f).padStart(6)).join(''))
  for (const o of r.grid.onsets) console.log(String(o).padStart(6) + ' ' + r.grid.frames.map((f) => { const c = r.cells.find((c) => c.onset === o && c.frame === f); return c ? pct(c.f).padStart(6) : '     -' }).join(''))
  const best = [...r.cells].sort((a, b) => b.f - a.f)[0]
  const dflt = r.cells.find((c) => c.onset === 0.7 && c.frame === 0.5)
  const line = (label, c) => c && console.log(`${label} onset=${c.onset} frame=${c.frame}  P=${pct(c.p)}% R=${pct(c.r)}% F1=${pct(c.f)}%  曲別中央値 ${pct(c.medF)}%  (正解${c.nRef}音 / 予測${c.nEst}音)`)
  line('アプリ既定 ', dflt)
  line('最良       ', best)
  console.log('onset 別の最良 frame: ' + r.grid.onsets.map((o) => { const b = r.cells.filter((c) => c.onset === o).sort((a, b) => b.f - a.f)[0]; return `${o}→${b.frame}(${(100 * b.f).toFixed(1)})` }).join('  '))
}
if (results.length > 1) {
  const base = results[0]
  console.log(`\n=== 比較(基準: ${path.basename(base.dir)})。F1 差(ポイント)、行=onset 列=frame ===`)
  for (const r of results.slice(1)) {
    console.log(`--- ${path.basename(r.dir)} − 基準`)
    console.log('       ' + r.grid.frames.map((f) => String(f).padStart(6)).join(''))
    for (const o of r.grid.onsets) console.log(String(o).padStart(6) + ' ' + r.grid.frames.map((f) => { const a = base.cells.find((c) => c.onset === o && c.frame === f), b = r.cells.find((c) => c.onset === o && c.frame === f); return a && b ? (100 * (b.f - a.f)).toFixed(1).padStart(6) : '     -' }).join(''))
    const bestBase = [...base.cells].sort((a, b) => b.f - a.f)[0], bestR = [...r.cells].sort((a, b) => b.f - a.f)[0]
    console.log(`最良同士: 基準 F1=${pct(bestBase.f)}% (${bestBase.onset}/${bestBase.frame})  vs  ${pct(bestR.f)}% (${bestR.onset}/${bestR.frame})  差 ${(100 * (bestR.f - bestBase.f)).toFixed(1)} pt`)
  }
}
