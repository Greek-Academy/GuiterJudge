// 圧縮 MusicXML(.mxl = ZIP)の展開。依存ゼロ。
// ZIP のセントラルディレクトリを読み、META-INF/container.xml の rootfile が指す楽譜本体を取り出す。
// deflate の展開は DecompressionStream('deflate-raw')(Chrome 103+ / Safari 16.4+ / Firefox 113+、Node 18+)。

export type InflateRaw = (data: Uint8Array) => Promise<Uint8Array> | Uint8Array

type Entry = { name: string; method: number; compSize: number; size: number; localOffset: number }

function readEntries(buf: Uint8Array): Entry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // EOCD (0x06054b50) を末尾から探す(コメント最大 64 KB)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP: セントラルディレクトリが見つかりません(壊れた .mxl)')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const entries: Entry[] = []
  const dec = new TextDecoder()
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP: セントラルディレクトリの項目が不正です')
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    entries.push({ name, method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function readEntry(buf: Uint8Array, e: Entry, inflate: InflateRaw): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(e.localOffset, true) !== 0x04034b50) throw new Error('ZIP: ローカルヘッダが不正です')
  const nameLen = dv.getUint16(e.localOffset + 26, true)
  const extraLen = dv.getUint16(e.localOffset + 28, true)
  const start = e.localOffset + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + e.compSize)
  if (e.method === 0) return data
  if (e.method === 8) return await inflate(data)
  throw new Error(`ZIP: 未対応の圧縮方式です(method ${e.method})`)
}

/** DecompressionStream('deflate-raw') による展開(ブラウザ・Node 共通の Web API) */
export const inflateRawWithStream: InflateRaw = async (data) => {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream がこの環境にありません(.mxl を展開できません)')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** .mxl のバイト列から楽譜 XML の文字列と、container.xml が指したパスを返す */
export async function extractMxl(buf: Uint8Array, inflate: InflateRaw = inflateRawWithStream): Promise<{ xml: string; rootfile: string }> {
  const entries = readEntries(buf)
  const dec = new TextDecoder()
  let rootPath: string | undefined
  const container = entries.find((e) => e.name === 'META-INF/container.xml')
  if (container) {
    const cx = dec.decode(await readEntry(buf, container, inflate))
    const m = /<rootfile[^>]*full-path="([^"]+)"/.exec(cx)
    if (m) rootPath = m[1]
  }
  if (!rootPath) {
    // container.xml が無い/壊れている .mxl。META-INF 以外の最初の XML を楽譜とみなす
    const cand = entries.find((e) => !e.name.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(e.name))
    if (!cand) throw new Error('.mxl の中に楽譜ファイル(.xml / .musicxml)が見つかりません')
    rootPath = cand.name
  }
  const root = entries.find((e) => e.name === rootPath)
  if (!root) throw new Error(`.mxl の container.xml が指す ${rootPath} がアーカイブにありません`)
  return { xml: decodeXmlBytes(await readEntry(buf, root, inflate)), rootfile: rootPath }
}

/** ZIP(= .mxl)かどうかをマジックナンバーで判定 */
export function isZip(buf: Uint8Array): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4
}

/** XML のバイト列を文字列に。BOM があれば UTF-16 も受け付ける(Finale 等の書き出し) */
export function decodeXmlBytes(buf: Uint8Array): string {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  }
  return new TextDecoder().decode(buf)
}
