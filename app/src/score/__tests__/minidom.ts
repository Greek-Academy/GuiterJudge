// node のテスト用の最小 XML パーサ(ブラウザでは DOMParser を使うので本体には入れない)。
// MusicXML を読むのに必要な範囲だけ: 要素・属性・テキスト・自己終了タグ・コメント・CDATA・DOCTYPE・処理命令・基本エンティティ。
import type { XEl } from '../xmlTree.ts'

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITY[body] ?? m
  })
}

export function parseXml(src: string): XEl {
  const root: XEl = { name: '#document', attrs: {}, children: [], text: '' }
  const stack: XEl[] = [root]
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? n : end)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE。内部サブセット [...] を含む場合もあるので括弧の深さを追う
      let depth = 0
      let j = lt + 2
      for (; j < n; j++) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth === 0) break
      }
      i = j + 1
      continue
    }
    let j = lt + 1
    let quote: string | null = null
    for (; j < n; j++) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    const body = src.slice(lt + 1, j)
    i = j + 1
    if (body[0] === '/') {
      const name = body.slice(1).trim()
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k
          break
        }
      }
      continue
    }
    const selfClose = body.endsWith('/')
    const inner = selfClose ? body.slice(0, -1) : body
    const m = /^([^\s/>]+)\s*([\s\S]*)$/.exec(inner)
    if (!m) continue
    const el: XEl = { name: m[1], attrs: {}, children: [], text: '' }
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let am: RegExpExecArray | null
    while ((am = re.exec(m[2]))) el.attrs[am[1]] = decodeEntities(am[2] ?? am[3] ?? '')
    stack[stack.length - 1].children.push(el)
    if (!selfClose) stack.push(el)
  }
  return root
}
