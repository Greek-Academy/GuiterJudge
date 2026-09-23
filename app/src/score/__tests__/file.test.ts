/// <reference types="node" />
// ファイル入口: .mxl(ZIP + DecompressionStream)の展開、parseScoreFile の種別判定、DOM アダプタ
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { parseScoreFile, isScoreFileName, convertMusicXml, extractMxl, isZip } from '../index.ts'
import { fromDomDocument } from '../xmlTree.ts'
import { parseXml } from './minidom.ts'
import { N, REST, convert, simpleScore, triples } from './fixtures.ts'

// --- テスト用の最小 ZIP ライタ(ローカルヘッダ + セントラルディレクトリ + EOCD) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zip(files: { name: string; data: string; store?: boolean }[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const raw = enc.encode(f.data)
    const comp = f.store ? raw : new Uint8Array(deflateRawSync(raw))
    const method = f.store ? 0 : 8
    const crc = crc32(raw)
    const lh = new Uint8Array(30 + name.length)
    const ldv = new DataView(lh.buffer)
    ldv.setUint32(0, 0x04034b50, true)
    ldv.setUint16(4, 20, true)
    ldv.setUint16(8, method, true)
    ldv.setUint32(14, crc, true)
    ldv.setUint32(18, comp.length, true)
    ldv.setUint32(22, raw.length, true)
    ldv.setUint16(26, name.length, true)
    lh.set(name, 30)
    locals.push(lh, comp)
    const ch = new Uint8Array(46 + name.length)
    const cdv = new DataView(ch.buffer)
    cdv.setUint32(0, 0x02014b50, true)
    cdv.setUint16(4, 20, true)
    cdv.setUint16(6, 20, true)
    cdv.setUint16(10, method, true)
    cdv.setUint32(16, crc, true)
    cdv.setUint32(20, comp.length, true)
    cdv.setUint32(24, raw.length, true)
    cdv.setUint16(28, name.length, true)
    cdv.setUint32(42, offset, true)
    ch.set(name, 46)
    centrals.push(ch)
    offset += lh.length + comp.length
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const edv = new DataView(eocd.buffer)
  edv.setUint32(0, 0x06054b50, true)
  edv.setUint16(8, files.length, true)
  edv.setUint16(10, files.length, true)
  edv.setUint32(12, cdSize, true)
  edv.setUint32(16, offset, true)
  const parts = [...locals, ...centrals, eocd]
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

const CONTAINER = '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'
const SCORE_XML = simpleScore([[N('E', 2, 8), N('A', 2, 8)], [N('D', 3, 16)]])
const EXPECTED: [number, number, number][] = [
  [40, 0, 1000],
  [45, 1000, 1000],
  [50, 2000, 2000],
]

test('.mxl: META-INF/container.xml の rootfile を展開し、平文の .musicxml と同じ結果になる', async () => {
  const bytes = zip([
    { name: 'META-INF/container.xml', data: CONTAINER, store: true },
    { name: 'score.xml', data: SCORE_XML },
  ])
  assert.equal(isZip(bytes), true)
  const parsed = await parseScoreFile(new Blob([bytes as BlobPart]), 'song.mxl', { parseXml })
  assert.equal(parsed.format, 'mxl')
  assert.equal(parsed.rootfile, 'score.xml')
  assert.equal(parsed.fileName, 'song.mxl')
  assert.equal(parsed.byteLength, bytes.length)
  const conv = convertMusicXml(parsed.xml)
  assert.deepEqual(triples(conv), EXPECTED)
  assert.deepEqual(triples(convert(SCORE_XML)), EXPECTED)
})

test('.mxl: container.xml が無ければ META-INF 以外の最初の XML を楽譜とみなす。壊れた ZIP は Error', async () => {
  const bytes = zip([{ name: 'anything.musicxml', data: SCORE_XML }])
  const { xml, rootfile } = await extractMxl(bytes)
  assert.equal(rootfile, 'anything.musicxml')
  assert.match(xml, /<score-partwise/)
  await assert.rejects(extractMxl(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0])), /ZIP/)
  await assert.rejects(extractMxl(zip([{ name: 'META-INF/container.xml', data: CONTAINER }])), /見つかりません|ありません/)
})

test('平文の MusicXML は中身で判定する(拡張子が .xml でも .musicxml でも)。MusicXML でなければ Error', async () => {
  for (const name of ['a.musicxml', 'A.XML']) {
    const parsed = await parseScoreFile(new Blob([SCORE_XML]), name, { parseXml })
    assert.equal(parsed.format, 'musicxml')
    assert.equal(parsed.rootfile, undefined)
    assert.deepEqual(triples(convertMusicXml(parsed.xml)), EXPECTED)
  }
  await assert.rejects(parseScoreFile(new Blob(['<?xml version="1.0"?><svg/>']), 'x.xml', { parseXml }), /MusicXML ではない/)
  await assert.rejects(parseScoreFile(new Blob([new Uint8Array([1, 2, 3, 4, 5])]), 'x.mid', { parseXml }), /MusicXML ではない/)
})

test('UTF-16(BOM 付き)の MusicXML も読める', async () => {
  const buf = new Uint8Array(2 + SCORE_XML.length * 2)
  buf[0] = 0xff
  buf[1] = 0xfe
  for (let i = 0; i < SCORE_XML.length; i++) {
    const c = SCORE_XML.charCodeAt(i)
    buf[2 + i * 2] = c & 0xff
    buf[3 + i * 2] = c >> 8
  }
  const parsed = await parseScoreFile(new Blob([buf as BlobPart]), 'u16.xml', { parseXml })
  assert.deepEqual(triples(convertMusicXml(parsed.xml)), EXPECTED)
})

test('isScoreFileName は .musicxml / .xml / .mxl(大文字も)だけを受け付ける', () => {
  assert.equal(isScoreFileName('a.musicxml'), true)
  assert.equal(isScoreFileName('a.MXL'), true)
  assert.equal(isScoreFileName('a.xml'), true)
  assert.equal(isScoreFileName('a.mid'), false)
  assert.equal(isScoreFileName('a.gp5'), false)
})

// --- DOM アダプタ(node に DOMParser は無いので、最小の DOM 風オブジェクトで fromDomDocument を検証) ---

type FakeNode = { nodeType: number; nodeValue?: string | null; localName?: string; nodeName?: string; attributes?: { name: string; value: string }[]; childNodes?: FakeNode[] }

function toFakeDom(el: ReturnType<typeof parseXml>): FakeNode {
  const childNodes: FakeNode[] = []
  if (el.text) childNodes.push({ nodeType: 3, nodeValue: el.text })
  for (const c of el.children) childNodes.push(toFakeDom(c))
  return { nodeType: 1, localName: el.name, nodeName: el.name, attributes: Object.entries(el.attrs).map(([name, value]) => ({ name, value })), childNodes }
}

test('fromDomDocument は DOM(Document)を XEl ツリーに写し、convertMusicXml は Document を直接受け取れる', () => {
  const xml = simpleScore([[N('C', 4, 4, { tie: 'start' }), N('C', 4, 4, { tie: 'stop' }), REST(8)]])
  const tree = parseXml(xml)
  const fakeDoc = { nodeType: 9, documentElement: toFakeDom(tree.children[0]) } as unknown as Document
  const viaDom = fromDomDocument(fakeDoc)
  assert.equal(viaDom.children[0].name, 'score-partwise')
  assert.deepEqual(triples(convertMusicXml(viaDom)), triples(convertMusicXml(tree)))
  assert.deepEqual(triples(convertMusicXml(fakeDoc)), [[60, 0, 1000]])
})
