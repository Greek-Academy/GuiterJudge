// GAPS 採点の共通部品: SMF パーサ、音符の1対1対応付け、P/R/F1、メタデータ CSV の split 読み取り。
// gaps-notes.mjs(固定閾値の採点)と gaps-sweep.mjs(閾値スイープの採点)から使う。
import fs from 'node:fs'
import path from 'node:path'

// --- 最小限の SMF パーサ(format 0/1、note on/off、テンポ) ---
export function parseMidi(buf) {
  let p = 0
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v }
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v }
  if (buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('not midi')
  p = 8; const format = u16(); const ntrks = u16(); const division = u16()
  if (division & 0x8000) throw new Error('SMPTE division unsupported')
  const tempos = [{ tick: 0, usPerQ: 500000 }]
  const notes = []
  for (let t = 0; t < ntrks; t++) {
    if (buf.toString('ascii', p, p + 4) !== 'MTrk') throw new Error('bad track')
    p += 4; const len = u32(); const end = p + len
    let tick = 0; let status = 0
    const on = new Map()
    const vlq = () => { let v = 0; for (;;) { const b = buf[p++]; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) return v } }
    while (p < end) {
      tick += vlq()
      let b = buf[p]
      if (b & 0x80) { status = b; p++ } else b = status
      if (status === 0xff) { const type = buf[p++]; const l = vlq(); if (type === 0x51) tempos.push({ tick, usPerQ: (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2] }); p += l }
      else if (status === 0xf0 || status === 0xf7) { const l = vlq(); p += l }
      else {
        const hi = status & 0xf0
        const d1 = buf[p++]; const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : buf[p++]
        if (hi === 0x90 && d2 > 0) { on.set(d1, tick) }
        else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) { const st = on.get(d1); if (st !== undefined) { notes.push({ pitch: d1, startTick: st, endTick: tick }); on.delete(d1) } }
      }
    }
    p = end
  }
  tempos.sort((a, b) => a.tick - b.tick)
  // tick → ms(テンポマップ)
  const segs = []; let ms = 0
  for (let i = 0; i < tempos.length; i++) {
    const next = tempos[i + 1]
    segs.push({ tick: tempos[i].tick, ms, usPerTick: tempos[i].usPerQ / division })
    if (next) ms += ((next.tick - tempos[i].tick) * tempos[i].usPerQ) / division / 1000
  }
  const toMs = (tick) => { let s = segs[0]; for (const g of segs) if (g.tick <= tick) s = g; return s.ms + ((tick - s.tick) * s.usPerTick) / 1000 }
  return { format, notes: notes.map((n) => ({ pitch: n.pitch, startMs: toMs(n.startTick), durationMs: toMs(n.endTick) - toMs(n.startTick) })).sort((a, b) => a.startMs - b.startMs) }
}

// --- 1対1対応付け(二部マッチング、増加路)。候補: |onset差| <= tol かつ音高一致(octaveTolerant なら mod 12) ---
// 戻り値は一致数。直前の呼び出しで対応が付いた正解音の添字集合を matchNotes.lastMatchedRef に残す
export function matchNotes(ref, est, tolMs, octaveTolerant = false) {
  const cand = ref.map((r) => est.map((e, j) => (Math.abs(r.startMs - e.startMs) <= tolMs && (octaveTolerant ? (r.pitch - e.pitch) % 12 === 0 : r.pitch === e.pitch) ? j : -1)).filter((j) => j >= 0))
  const matchOfEst = new Array(est.length).fill(-1)
  const tryAssign = (i, seen) => { for (const j of cand[i]) { if (seen[j]) continue; seen[j] = true; if (matchOfEst[j] < 0 || tryAssign(matchOfEst[j], seen)) { matchOfEst[j] = i; return true } } return false }
  let m = 0
  for (let i = 0; i < ref.length; i++) if (tryAssign(i, new Array(est.length).fill(false))) m++
  matchNotes.lastMatchedRef = new Set(matchOfEst.filter((i) => i >= 0))
  return m
}

export const prf = (m, nRef, nEst) => { const p = nEst ? m / nEst : 0, r = nRef ? m / nRef : 0; return { p, r, f: p + r ? (2 * p * r) / (p + r) : 0 } }

// --- メタデータ CSV。引用符付きの複数行セルがあるので状態機械で読む ---
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** GAPS の曲 ID 一覧。split('train' | 'test')を渡すとその split だけ(空セルの曲は splitless として除外) */
export function readGapsIds(dataDir, split) {
  const rows = parseCsv(fs.readFileSync(path.join(dataDir, 'gaps_metadata_with_splits.csv'), 'utf8'))
  const header = rows[0]; const iId = header.indexOf('id'); const iSplit = header.indexOf('split')
  return rows.slice(1).filter((r) => /^\d{3}_[A-Za-z0-9-]{5}$/.test(r[iId] ?? '') && (!split || r[iSplit] === split)).map((r) => r[iId])
}
