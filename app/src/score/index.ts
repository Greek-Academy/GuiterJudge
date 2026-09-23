// 楽譜ファイル(MusicXML / .mxl)→ NoteEvent[] の公開 API。
// 使い方(UI 側):
//   const parsed = await parseScoreFile(file, file.name)       // 種別判定・.mxl 展開・XML パース
//   let conv = convertMusicXml(parsed.xml, { bpm })             // NoteEvent[] + 小節・統計・警告
//   conv = sliceMeasures(conv, fromIdx, toIdx)                  // 第 N〜M 小節(conv.measures のインデックス)だけに
//   conv = retime(conv, 90)                                     // BPM を変えて ms を再計算
import { extractMxl, isZip, decodeXmlBytes } from './mxl.ts'
import { parseXmlWithDomParser, type XEl } from './xmlTree.ts'

export { convertMusicXml, sliceMeasures, retime, GUITAR_LOW, GUITAR_HIGH } from './musicxml.ts'
export type {
  ConvertOptions,
  ScoreConversion,
  ScoreWarning,
  ScoreWarningCode,
  ScoreStats,
  ScorePart,
  PlayedMeasure,
  ScoreTimeline,
  TimelineNote,
  TimelineMeasure,
  RenderOptions,
} from './musicxml.ts'
export { extractMxl, isZip } from './mxl.ts'
export type { XEl } from './xmlTree.ts'

export type ScoreFileFormat = 'musicxml' | 'mxl'

export type ParsedScore = {
  fileName: string
  format: ScoreFileFormat
  /** .mxl の場合、container.xml が指していた楽譜ファイルのパス */
  rootfile?: string
  /** 元ファイルのバイト数 */
  byteLength: number
  /** パース済み XML ツリー(convertMusicXml に渡す) */
  xml: XEl
}

export type ParseScoreFileOptions = {
  /** XML 文字列 → ツリー。既定はブラウザの DOMParser(node のテストでは minidom を渡す) */
  parseXml?: (xml: string) => XEl
}

/** 受け付ける拡張子(input[type=file] の accept 用) */
export const SCORE_FILE_EXTENSIONS = ['.musicxml', '.xml', '.mxl'] as const
export const SCORE_FILE_ACCEPT = [...SCORE_FILE_EXTENSIONS, 'application/vnd.recordare.musicxml+xml', 'application/vnd.recordare.musicxml'].join(',')

/** ファイル名が楽譜ファイルとして受け付けられる拡張子か */
export function isScoreFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return SCORE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 楽譜ファイルを読んでパース済みツリーにする。種別は中身のマジックナンバーで判定する
 * (.mxl = ZIP。拡張子が .xml でも ZIP なら展開する)。整形式でない XML・壊れた ZIP は Error。
 */
export async function parseScoreFile(file: File | Blob, name: string, opts: ParseScoreFileOptions = {}): Promise<ParsedScore> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const parse = opts.parseXml ?? parseXmlWithDomParser
  if (isZip(buf)) {
    const { xml, rootfile } = await extractMxl(buf)
    return { fileName: name, format: 'mxl', rootfile, byteLength: buf.byteLength, xml: parse(xml) }
  }
  const textXml = decodeXmlBytes(buf)
  if (!/<score-(partwise|timewise)/.test(textXml)) {
    throw new Error(`${name} は MusicXML ではないようです(score-partwise が見つかりません)`)
  }
  return { fileName: name, format: 'musicxml', byteLength: buf.byteLength, xml: parse(textXml) }
}
