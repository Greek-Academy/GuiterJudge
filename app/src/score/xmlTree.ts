// MusicXML 変換が走査する最小の XML ツリー型と、ブラウザ DOM(DOMParser)からの写し。
// 変換の核(musicxml.ts)は DOM に直接依存せずこの型だけを見るので、
// node のテストでは __tests__/minidom.ts の自前パーサで同じ型を作って流せる。

export type XEl = {
  name: string
  attrs: Record<string, string>
  children: XEl[]
  /** 直下のテキストノードの連結(子孫のテキストは含まない) */
  text: string
}

export function child(el: XEl | undefined, name: string): XEl | undefined {
  if (!el) return undefined
  for (const c of el.children) if (c.name === name) return c
  return undefined
}

export function children(el: XEl | undefined, name: string): XEl[] {
  if (!el) return []
  return el.children.filter((c) => c.name === name)
}

export function text(el: XEl | undefined): string {
  return el ? el.text.trim() : ''
}

export function num(el: XEl | undefined, fallback = NaN): number {
  const t = text(el)
  if (!t) return fallback
  const v = Number(t)
  return Number.isFinite(v) ? v : fallback
}

/** 子孫を深さ優先で探す(最初の 1 つ) */
export function find(el: XEl | undefined, name: string): XEl | undefined {
  if (!el) return undefined
  for (const c of el.children) {
    if (c.name === name) return c
    const d = find(c, name)
    if (d) return d
  }
  return undefined
}

/** 子孫をすべて集める(深さ優先) */
export function findAll(el: XEl | undefined, name: string, out: XEl[] = []): XEl[] {
  if (!el) return out
  for (const c of el.children) {
    if (c.name === name) out.push(c)
    findAll(c, name, out)
  }
  return out
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4

function fromDomElement(el: Element): XEl {
  const attrs: Record<string, string> = {}
  for (const a of el.attributes) attrs[a.name] = a.value
  const out: XEl = { name: el.localName || el.nodeName, attrs, children: [], text: '' }
  // 再帰ではなく明示スタックで写す(深い楽譜でもスタックを食わない)
  const stack: { src: Element; dst: XEl }[] = [{ src: el, dst: out }]
  while (stack.length) {
    const { src, dst } = stack.pop()!
    for (const n of src.childNodes) {
      if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_SECTION_NODE) {
        dst.text += n.nodeValue ?? ''
      } else if (n.nodeType === ELEMENT_NODE) {
        const e = n as Element
        const a: Record<string, string> = {}
        for (const at of e.attributes) a[at.name] = at.value
        const c: XEl = { name: e.localName || e.nodeName, attrs: a, children: [], text: '' }
        dst.children.push(c)
        stack.push({ src: e, dst: c })
      }
    }
  }
  return out
}

/** DOM の Document を XEl ツリーに写す。返る要素は仮想のルート(#document)で、その子に score-partwise が来る */
export function fromDomDocument(doc: Document): XEl {
  const root: XEl = { name: '#document', attrs: {}, children: [], text: '' }
  if (doc.documentElement) root.children.push(fromDomElement(doc.documentElement))
  return root
}

/** ブラウザの DOMParser で XML 文字列を読む。整形式でなければ Error */
export function parseXmlWithDomParser(xml: string): XEl {
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser がこの環境にありません(node では __tests__/minidom.ts を使ってください)')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error(`XML の解析に失敗しました: ${(err.textContent ?? '').trim().slice(0, 200)}`)
  return fromDomDocument(doc)
}
