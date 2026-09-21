// ヘッドレス Chrome(CDP)で GAPS の各曲に transcribe() をかけ、結果を JSON で保存する。準備手順は eval/gaps-harness.ts の先頭。
//   node eval/gaps-drive.mjs <data-dir> <results-dir> [cropSec=60] [limit=0] [--split=test] [--sweep] [--onsets=0.2,...] [--frames=0.1,...] [--dataset=guitarset]
// 既定は audio/ にある曲すべて。--split=test でメタデータの test split(30 曲)だけに絞る(学習用音声も落とした後はこちら)。
// 結果が既にある曲は飛ばすので再実行できる。
// --sweep: 推論1回で閾値グリッドぶんの音符列を保存する(採点は gaps-sweep.mjs)。既定グリッドは onset 0.2〜0.9、frame 0.1〜0.8(0.1 刻み)
// --dataset=guitarset: <data-dir> を GuitarSet とみなし、奏者 05 の test 60 クリップ(audio/<id>_mic.wav、配信は /audio-guitarset/)を回す
import fs from 'node:fs'
import path from 'node:path'
import { readGapsIds, readGuitarSetTestIds } from './gaps-score-lib.mjs'
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true] }))
const [DATA, OUT, CROP = '60', LIMIT = '0'] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const SWEEP = flags.sweep === true
const parseGrid = (s, dflt) => (typeof s === 'string' ? s.split(',').map(Number) : dflt)
const ONSETS = parseGrid(flags.onsets, [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
const FRAMES = parseGrid(flags.frames, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
const GUITARSET = flags.dataset === 'guitarset'
const audioFile = (id) => (GUITARSET ? id + '_mic.wav' : id + '.wav')
const audioRoute = GUITARSET ? '/audio-guitarset/' : '/audio/'
const ids = GUITARSET ? readGuitarSetTestIds(DATA) : readGapsIds(DATA, typeof flags.split === 'string' ? flags.split : undefined)
const testIds = ids.filter((id) => fs.existsSync(path.join(DATA, 'audio', audioFile(id))))
console.log(`targets: ${testIds.length} (${GUITARSET ? 'guitarset test' : `gaps split=${flags.split ?? 'all'}`}, ${ids.length} listed)${SWEEP ? `  sweep ${ONSETS.length}x${FRAMES.length}` : ''}`)

const targets = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0; const pending = new Map(); const errors = []
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300)) }
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result.result.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
// serve/model のシンボリックリンクを差し替えて別モデルを回すので、前回のモデルがキャッシュから出てこないようにする
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: 'http://127.0.0.1:8765/' })
for (let i = 0; i < 60; i++) { if (await evalJs('window.__ready === true')) break; await sleep(1000) }
if (!(await evalJs('window.__ready === true'))) throw new Error('harness not ready: ' + errors.join('\n'))
fs.mkdirSync(OUT, { recursive: true })
if (SWEEP) fs.writeFileSync(path.join(OUT, 'grid.json'), JSON.stringify({ onsets: ONSETS, frames: FRAMES, cropSec: Number(CROP) }))
let n = 0
for (const tid of testIds) {
  if (Number(LIMIT) && n >= Number(LIMIT)) break
  const outFile = path.join(OUT, tid + '.json')
  if (fs.existsSync(outFile)) { console.log('skip', tid); n++; continue }
  const t0 = Date.now()
  let json = null
  for (const backend of ['webgl', 'cpu']) {
    const call = SWEEP
      ? `window.__transcribeSweep('${audioRoute}${audioFile(tid)}', ${Number(CROP)}, '${backend}', ${JSON.stringify(ONSETS)}, ${JSON.stringify(FRAMES)})`
      : `window.__transcribe('${audioRoute}${audioFile(tid)}', ${Number(CROP)}, '${backend}')`
    try { json = await evalJs(call); break }
    catch (e) { console.log(`${tid}  ${backend} failed: ${String(e).slice(0, 120)}`) }
  }
  if (json) {
    fs.writeFileSync(outFile, json)
    const r = JSON.parse(json)
    const wall = Math.round((Date.now() - t0) / 1000)
    if (SWEEP) {
      const dflt = r.cells.find((c) => c.onset === 0.7 && c.frame === 0.5)
      console.log(`${tid}  ${r.durationSec.toFixed(0)}s audio  cells=${r.cells.length} notes@0.7/0.5=${dflt?.notes.length ?? '-'} offset=${r.analysisOffsetMs}ms  infer=${Math.round(r.inferenceMs / 1000)}s post=${Math.round(r.postprocessMs / 1000)}s wall=${wall}s  ${r.backend}`)
    } else {
      console.log(`${tid}  ${r.durationSec.toFixed(0)}s audio  notes=${r.noteEvents.length} merged=${r.merged.length} offset=${r.analysisOffsetMs}ms  infer=${Math.round(r.timings.inferenceMs / 1000)}s wall=${wall}s  ${r.backend}`)
    }
  }
  n++
}
if (errors.length) console.log('console errors:', errors.slice(0, 5))
ws.close()
