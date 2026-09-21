import fs from 'node:fs'
import path from 'node:path'
import { recognizeChords, chordProgression, diagnoseChords, type ChordEvent } from '../src/chordRecognition'

// GuitarSet(実ギター録音 360 本・コード注釈付き、CC BY 4.0)で和音認識(chordRecognition.ts)を評価する。
// 本番のパイプラインと同じ 22050Hz に落としてから recognizeChords() を呼ぶ。
//
// 準備(Zenodo からの転送は途中で止まることがあるので再開オプション付き):
//   mkdir -p <dir> && cd <dir>
//   curl -L -C - --retry 30 --retry-all-errors -o annotation.zip     https://zenodo.org/api/records/3371780/files/annotation.zip/content
//   curl -L -C - --retry 30 --retry-all-errors -o audio_mono-mic.zip https://zenodo.org/api/records/3371780/files/audio_mono-mic.zip/content
//   unzip -oq annotation.zip -d annotation && unzip -oq audio_mono-mic.zip -d audio
//   (audio/ 直下に <name>_mic.wav が 360 本、annotation/ 直下に <name>.jams が 360 本ある状態にする)
// 実行(依存を増やさないため rolldown でバンドルして Node で走らせる。tsc の対象外なので型検査は通らない):
//   node_modules/.bin/rolldown eval/guitarset-chords.ts --platform node --format esm --file /tmp/gs.mjs && node /tmp/gs.mjs <dir>
// 結果は SPEC.md 5.6 に記録している。

const ROOT = process.argv[2]
const LIMIT = Number(process.argv[3] ?? 0) // 先頭 N ファイルだけで試すとき
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E' }

// --- WAV ---
function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const b = fs.readFileSync(file)
  let off = 12
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) }
    else if (id === 'data') {
      if (!fmt) throw new Error('fmt before data expected')
      const bytes = fmt.bits / 8
      const n = Math.floor(size / bytes / fmt.channels)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let acc = 0
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * bytes
          if (fmt.format === 3) acc += b.readFloatLE(p)
          else if (bytes === 2) acc += b.readInt16LE(p) / 32768
          else if (bytes === 3) acc += ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8 >> 8) / 8388608
          else if (bytes === 4) acc += b.readInt32LE(p) / 2147483648
        }
        out[i] = acc / fmt.channels
      }
      return { samples: out, sampleRate: fmt.sampleRate }
    }
    off = body + size + (size & 1)
  }
  throw new Error('no data chunk: ' + file)
}

/** 44100 → 22050: 2サンプル平均(簡易ローパス)で間引く。評価用途なので厳密なフィルタは使わない */
function toAnalysisRate(s: Float32Array, sr: number): { samples: Float32Array; sampleRate: number } {
  if (sr === 22050) return { samples: s, sampleRate: sr }
  if (sr === 44100) {
    const out = new Float32Array(Math.floor(s.length / 2))
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * (s[2 * i] + s[2 * i + 1])
    return { samples: out, sampleRate: 22050 }
  }
  throw new Error('unsupported sample rate ' + sr)
}

// --- JAMS ---
// GuitarSet の chord 注釈は2本: 1本目が譜面(instructed、"D#:maj" 等の素朴なラベル)、
// 2本目が実際に弾いた音の書き起こし(performed、"D#:sus2(7)/1" のように拡張音と転回形付き)。
// 「弾こうとしたコードが読めるか」を測るので、正解は譜面(instructed)のほうを使う。
type GtChord = { time: number; duration: number; root: number | null; quality: string; label: string }
function parseLabel(v: string): { root: number | null; quality: string } {
  if (v === 'N' || v === 'X') return { root: null, quality: 'N' }
  const [r, rest = 'maj'] = v.split(':')
  const rn = FLAT[r] ?? r
  const root = NAMES.indexOf(rn)
  const quality = rest.split('/')[0].split('(')[0] || 'maj'
  return { root: root < 0 ? null : root, quality }
}
function readJams(file: string): { instructed: GtChord[]; performed: GtChord[] } {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const anns = j.annotations.filter((a: any) => a.namespace === 'chord')
  const conv = (a: any): GtChord[] => a.data.map((d: any) => ({ time: d.time, duration: d.duration, label: d.value, ...parseLabel(d.value) }))
  return { instructed: conv(anns[0]), performed: conv(anns[anns.length - 1]) }
}

// --- 評価 ---
/** GuitarSet の細かいコード種を、認識器の語彙(maj/min/7/min7)に写す。写せないものは null(評価から外す) */
function toVocab(q: string): 'maj' | 'min' | '7' | 'min7' | null {
  if (['maj', 'maj6', 'maj7', 'maj9', 'sus2', 'sus4', 'add9', '6'].includes(q)) return 'maj'
  if (['min', 'min6', 'min9', 'minmaj7'].includes(q)) return 'min'
  if (['7', '9', '11', '13'].includes(q)) return '7'
  if (['min7', 'min11', 'min13'].includes(q)) return 'min7'
  return null // dim, hdim7, aug, パワーコード等は評価から外す
}
function thirdOf(q: string): 'maj' | 'min' | null {
  const v = toVocab(q)
  if (v === 'maj' || v === '7') return 'maj'
  if (v === 'min' || v === 'min7') return 'min'
  return null
}
function gtAt(gt: GtChord[], t: number): GtChord | undefined {
  return gt.find((c) => t >= c.time && t < c.time + c.duration)
}
function predAt(pred: ChordEvent[], tMs: number): ChordEvent | undefined {
  return pred.find((e) => tMs >= e.startMs && tMs < e.endMs)
}

type Tally = { frames: number; root: number; majmin: number; exact: number; nFrames: number; nPredN: number }
const zero = (): Tally => ({ frames: 0, root: 0, majmin: 0, exact: 0, nFrames: 0, nPredN: 0 })
function add(t: Tally, gt: GtChord[], pred: ChordEvent[], offsetMs: number) {
  const STEP = 50
  const end = gt.reduce((a, c) => Math.max(a, c.time + c.duration), 0) * 1000
  for (let tMs = 0; tMs < end; tMs += STEP) {
    const g = gtAt(gt, tMs / 1000)
    if (!g) continue
    const p = predAt(pred, tMs + offsetMs)
    if (g.root === null) { t.nFrames++; if (!p || p.root === null) t.nPredN++; continue }
    const third = thirdOf(g.quality)
    if (third === null) continue // 語彙外(dim/aug など)は数えない
    t.frames++
    if (!p || p.root === null) continue
    if (p.root === g.root) t.root++
    const pThird = p.quality === 'maj' || p.quality === '7' ? 'maj' : 'min'
    if (p.root === g.root && pThird === third) t.majmin++
    if (p.root === g.root && p.quality === toVocab(g.quality)) t.exact++
  }
}
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-')

const jamsDir = path.join(ROOT, 'annotation')
const audioDir = path.join(ROOT, 'audio')
const files = fs.readdirSync(jamsDir).filter((f) => f.endsWith('.jams')).sort()
const results: { name: string; style: string; mode: 'comp' | 'solo'; tally: Tally; gtProg: string[]; predProg: string[]; progMatch: number; pred: ChordEvent[] }[] = []
const byMode: Record<string, Tally> = { comp: zero(), solo: zero() }
const byStyle: Record<string, Tally> = {}
let done = 0
for (const f of files) {
  const name = f.replace('.jams', '')
  const wav = path.join(audioDir, name + '_mic.wav')
  if (!fs.existsSync(wav)) continue
  const mode: 'comp' | 'solo' = name.endsWith('comp') ? 'comp' : 'solo'
  const style = name.split('_')[1].split('-')[0] // e.g. "05_Rock1-130-A_comp" → Rock1
  const { instructed: performed } = readJams(path.join(jamsDir, f))
  const { samples, sampleRate } = toAnalysisRate(...Object.values(readWav(wav)) as [Float32Array, number])
  const pred = recognizeChords(samples, sampleRate)
  const tally = zero()
  add(tally, performed, pred, 0)
  byMode[mode] ??= zero()
  add(byMode[mode], performed, pred, 0)
  byStyle[style] ??= zero()
  add(byStyle[style], performed, pred, 0)

  // 進行レベル: 正解の並び(N と同ラベル連続を畳む)と認識の並びを diagnoseChords で対応付け
  const gtEvents: ChordEvent[] = performed
    .filter((c) => c.root !== null && toVocab(c.quality))
    .map((c) => ({ root: c.root, quality: toVocab(c.quality), label: NAMES[c.root!] + ({ maj: '', min: 'm', '7': '7', min7: 'm7' } as any)[toVocab(c.quality)!], startMs: c.time * 1000, endMs: (c.time + c.duration) * 1000, confidence: 1 }))
  const d = diagnoseChords(gtEvents, pred)
  results.push({ name, style, mode, tally, gtProg: chordProgression(gtEvents).map((e) => e.label), predProg: chordProgression(pred).map((e) => e.label), progMatch: d.chordMatchRate, pred })
  done++
  if (LIMIT && done >= LIMIT) break
}

console.log(`files: ${done}`)
const row = (label: string, t: Tally) => console.log(`${label.padEnd(12)} frames=${String(t.frames).padStart(6)}  root=${pct(t.root, t.frames).padStart(6)}  majmin=${pct(t.majmin, t.frames).padStart(6)}  exact=${pct(t.exact, t.frames).padStart(6)}  N-recall=${pct(t.nPredN, t.nFrames)}`)
console.log('\n## フレーム正解率(50msごと、正解が N の区間と dim/aug 等の語彙外は除く)')
for (const m of ['comp', 'solo']) row(m, byMode[m])
console.log('\n## スタイル別(comp のみ)')
const compByStyle: Record<string, Tally> = {}
for (const r of results) if (r.mode === 'comp') { compByStyle[r.style] ??= zero(); const t = compByStyle[r.style]; for (const k of Object.keys(t) as (keyof Tally)[]) t[k] += r.tally[k] }
for (const s of Object.keys(compByStyle).sort()) row(s, compByStyle[s])
console.log('\n## 進行レベルの一致率(diagnoseChords の chordMatchRate、comp)')
const comps = results.filter((r) => r.mode === 'comp').sort((a, b) => a.progMatch - b.progMatch)
const mean = comps.reduce((a, r) => a + r.progMatch, 0) / comps.length
console.log(`mean=${(100 * mean).toFixed(1)}%  median=${(100 * comps[Math.floor(comps.length / 2)].progMatch).toFixed(1)}%`)
console.log('\n## 悪いほう5件 / 良いほう3件(comp)')
for (const r of [...new Set([...comps.slice(0, 5), ...comps.slice(-3)])]) {
  console.log(`\n${r.name}  progMatch=${(100 * r.progMatch).toFixed(0)}%  root=${pct(r.tally.root, r.tally.frames)} majmin=${pct(r.tally.majmin, r.tally.frames)}`)
  console.log('  gt  :', r.gtProg.slice(0, 16).join(' '))
  console.log('  pred:', r.predProg.slice(0, 16).join(' '))
}
// アプリの実際の使い方に近い評価: 同じ譜面(スタイル-テンポ-キー)を別の奏者が弾いた comp どうしを
// diagnoseChords で比べる。譜面が同じなのでコード一致率は高いはずで、切り替えのばらつきは奏者間の差。
console.log('\n## 奏者間比較(同じ譜面を弾いた別奏者の comp どうし、diagnoseChords)')
const groups = new Map<string, typeof results>()
for (const r of results) if (r.mode === 'comp') { const key = r.name.split('_')[1]; groups.set(key, [...(groups.get(key) ?? []), r]) }
const pairRates: number[] = []; const pairJitters: number[] = []; const pairMissed: number[] = []
for (const rs of groups.values()) {
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const d = diagnoseChords(rs[i].pred, rs[j].pred)
    pairRates.push(d.chordMatchRate); pairJitters.push(d.chordChangeJitterMs); pairMissed.push(d.missedOrExtraChordCount)
  }
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
console.log(`pairs=${pairRates.length}  chordMatchRate mean=${(100 * pairRates.reduce((a, b) => a + b, 0) / pairRates.length).toFixed(1)}% median=${(100 * med(pairRates)).toFixed(1)}%  changeJitter median=${med(pairJitters)}ms  missedOrExtra median=${med(pairMissed)}`)
fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(results.map(({ pred: _p, ...r }) => r), null, 1))
