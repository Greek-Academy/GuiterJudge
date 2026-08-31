// 音名 ⇔ MIDIノート番号の変換と、タイミングを無視した音符列の照合。
// TranscriptionLab(M1の閾値チューニング)で「実際に弾いた音」を正解として与えるために使う。
// 科学的表記法(C4 = 中央ド = MIDI 60)に従う。

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SEMITONE_BY_LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export function pitchToName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`
}

/** "F#3" / "Bb2" / "60" のいずれかをMIDIノート番号にする。解釈できなければnull */
export function parsePitch(token: string): number | null {
  const t = token.trim()
  if (!t) return null

  if (/^\d+$/.test(t)) {
    const n = Number(t)
    return n >= 0 && n <= 127 ? n : null
  }

  const m = /^([A-Ga-g])([#b♯♭]*)(-?\d+)$/.exec(t)
  if (!m) return null
  const [, letter, accidentals, octave] = m
  let semitone = SEMITONE_BY_LETTER[letter.toUpperCase()]
  for (const ch of accidentals) {
    if (ch === '#' || ch === '♯') semitone += 1
    else semitone -= 1
  }
  const midi = (Number(octave) + 1) * 12 + semitone
  return midi >= 0 && midi <= 127 ? midi : null
}

/** スペース/カンマ/改行区切りの音名リストをパースする。解釈できないトークンは無視する */
export function parsePitchList(text: string): number[] {
  return text
    .split(/[\s,、]+/)
    .map(parsePitch)
    .filter((p): p is number => p !== null)
}

export type PitchDiff = {
  matched: number
  /** 期待した音が検出されなかった数 */
  missed: number
  /** 期待していない音が検出された数 */
  extra: number
  /** 対応は取れたが音高が違った数 */
  substituted: number
}

function isSamePitch(a: number, b: number, octaveTolerant: boolean): boolean {
  return octaveTolerant ? (a - b) % 12 === 0 : a === b
}

/**
 * 期待する音符列と検出された音符列を、タイミングを使わず音高の並びだけで照合する。
 * comparison.tsのアライメントはタイミングも使うが、こちらは「何を弾いたか」を手入力する
 * 検証用途なので、正解側にタイミング情報が存在しない前提で編集距離のみを取る。
 */
export function pitchSequenceDiff(expected: number[], detected: number[], octaveTolerant = false): PitchDiff {
  const n = expected.length
  const m = detected.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i
  for (let j = 0; j <= m; j++) dp[0][j] = j

  const subCost = (i: number, j: number) => (isSamePitch(expected[i - 1], detected[j - 1], octaveTolerant) ? 0 : 1)

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(dp[i - 1][j - 1] + subCost(i, j), dp[i - 1][j] + 1, dp[i][j - 1] + 1)
    }
  }

  const diff: PitchDiff = { matched: 0, missed: 0, extra: 0, substituted: 0 }
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + subCost(i, j)) {
      if (subCost(i, j) === 0) diff.matched++
      else diff.substituted++
      i--
      j--
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      diff.missed++
      i--
    } else {
      diff.extra++
      j--
    }
  }
  return diff
}
