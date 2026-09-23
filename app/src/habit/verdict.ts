import type { Take, Thread, DiagnosisResult } from '../db'
import { JITTER_METRIC } from '../components/trendMetrics'
import { MIN_ONSETS_FOR_GRID } from '../gridTiming'
import { daysSince, startOfDay } from './dailyStats'

/**
 * 「前回の自分と比べてどうだったか」の判定の核。React にも Dexie にも依存しない純関数だけを置く。
 * 引き分けの幅・音数の下限・テンポ条件はここ以外に散らさない(競合案の審査結果 5.0-6)。
 *
 * 審査結果の文書(competition-result.md)で決まっていなかった点は次のように決めた:
 *
 * - `ItemVerdict.note?`(追加): 項目ごとの注記。「基準が動く」「テンポを落としたため引き分け扱い」を入れる。
 * - `Verdict.notes`(追加): カード全体に出す注記の配列(テンポ低下・相対基準の説明)。無ければ空配列。
 * - `ItemVerdict.prev / cur` の単位: jitter は ms、match は **%(0〜100)** に変換済み、missed は個数。
 *   `unit` はそれぞれ 'ms' / '%' / ''。表示側は `Math.round` するだけでよい。
 * - 音数の下限 8 は、grid 比較では両テイクの `gridTiming.onsetCount`、相対比較では `curDiag.alignedNoteCount`
 *   (対応が付いた音の数。ペアの値なので今回側だけ見る)に当てる。
 * - `prev` が無い(初テイク)ときは `eligible: false` で reason は「比べる前回のテイクがまだありません」。
 *   `prev` はあるが比較結果がどちらにも無いときは「前回のテイクとの比較結果がありません」。
 * - テンポ条件で「勝ち」を引き分けに落とすのは jitter だけでなく 3 項目すべて(遅く弾けば一致率も上がるため)。
 *   勝ち以外(引き分け・負け)はそのまま。
 * - 安定ゲージでは、テンポを落とした回は勝ち負けを問わず 0(加算も減算もしない)。
 *   「テンポを落として揃えた回は数えません」の文言に合わせた。
 * - 3 連敗の判定用に `consecutiveJitterLosses` を追加で公開する(VersusCard が使う)。
 * - 発見(pickDiscovery)の型の選び方: 「過去ベスト更新」は該当すれば必ず出す(頻度が低く価値が高い)。
 *   それ以外は、該当する型の中からテイクの通し番号で巡回して選ぶ。保存無しで決定的に変化する。
 * - `latestOutcomeByThread` の 1 スレッド 1 値は、jitter 項目があればその勝敗、無ければ tally の多数決
 *   (同数は draw)。判定不能なら 'n/a'。
 * - 一致率・弾き忘れ/余分の勝敗は、直前テイクの「その直前比」の値(prevDiag)と比べる。
 *   つまり「今回は前回とどれだけ同じか」を「前回は前々回とどれだけ同じか」と比べている(一貫性の一貫性)。
 *   prevDiag が無い(前回が初テイク)ときはこの 2 項目は出さない。
 */

export type Outcome = 'win' | 'draw' | 'loss'
export type ItemVerdict = {
  key: 'jitter' | 'match' | 'missed'
  label: string
  prev: number
  cur: number
  unit: string
  outcome: Outcome
  /** 項目に添える注記(基準が動く、テンポ低下で引き分け扱い、など)。無ければ undefined */
  note?: string
}
export type Verdict = {
  /** false のときは items を出さず reason を出す */
  eligible: boolean
  /** '音数が少なく比べられません(8 音未満)' など */
  reason?: string
  /** eligible のとき 1〜3 件(メトロノーム・比較結果の有無で減る) */
  items: ItemVerdict[]
  tally: { win: number; draw: number; loss: number }
  /** どちらかがデモテイク */
  isDemo: boolean
  /** カード全体に添える注記(テンポを落とした、相対基準、など) */
  notes: string[]
}

/** ばらつきの引き分け幅(ms)。ScoreTrend の flatThreshold と同じ値・同じ態度 */
export const FLAT_JITTER_MS: number = JITTER_METRIC.flatThreshold
/** 一致率の引き分け幅(0〜1 の比率で 0.05 = 5 ポイント) */
export const FLAT_MATCH_RATE = 0.05
/** 弾き忘れ/余分の引き分け幅(個)。|Δ| ≤ 1 は引き分け */
export const FLAT_MISSED = 1
/** これ未満の音数では勝敗を出さない */
export const MIN_NOTES_FOR_VERDICT = 8
/** 相対比較で、前回よりこれ以上遅い(%)と「勝ち」を引き分けに落とす */
export const SLOWER_TEMPO_PCT = -8

/** 浮動小数の丸め誤差で 0.05 ちょうどが 0.0499999 になっても境界がぶれないようにする */
const EPS = 1e-9

const TEMPO_NOTE = 'テンポを落としたため引き分け扱い'
const RELATIVE_NOTE = '直前比のばらつきで判定(基準がテイクごとに変わるため、メトロノーム録音の値より粗い目安)'

type CurDiag = Pick<DiagnosisResult, 'noteMatchRate' | 'missedOrExtraNoteCount' | 'alignedNoteCount' | 'timingJitterMs' | 'tempoDiffPct'>
type PrevDiag = Pick<DiagnosisResult, 'noteMatchRate' | 'missedOrExtraNoteCount' | 'timingJitterMs'>

/** |Δ| が flat 未満なら引き分け。lowerIsBetter なら Δ<0 が勝ち */
function outcomeOf(delta: number, flat: number, lowerIsBetter: boolean): Outcome {
  if (Math.abs(delta) < flat - EPS) return 'draw'
  const improved = lowerIsBetter ? delta < 0 : delta > 0
  return improved ? 'win' : 'loss'
}

/** 弾き忘れ/余分は整数なので「|Δ| ≤ 1 は引き分け」を厳密に */
function outcomeOfMissed(delta: number): Outcome {
  if (Math.abs(delta) <= FLAT_MISSED) return 'draw'
  return delta < 0 ? 'win' : 'loss'
}

/** 格子解析が使える(メトロノーム録音で、解析に必要な音数が乗っている)か */
function gridOf(t: Pick<Take, 'gridTiming'>) {
  const g = t.gridTiming
  if (!g || !(g.jitterMs >= 0) || g.onsetCount < MIN_ONSETS_FOR_GRID) return null
  return g
}

/** 今回テイクを直前テイクと比べる。curDiag / prevDiag は compareMode 'prev' の結果(無ければ undefined) */
export function judgeAgainstPrev(args: {
  cur: Take
  prev: Take | undefined
  curDiag: CurDiag | undefined
  prevDiag: PrevDiag | undefined
}): Verdict {
  const { cur, prev, curDiag, prevDiag } = args
  const isDemo = cur.sourceType === 'demo' || prev?.sourceType === 'demo'
  const empty = (reason: string): Verdict => ({
    eligible: false,
    reason,
    items: [],
    tally: { win: 0, draw: 0, loss: 0 },
    isDemo,
    notes: [],
  })
  if (!prev) return empty('比べる前回のテイクがまだありません')

  const items: ItemVerdict[] = []
  const notes: string[] = []
  let tooFewNotes = false

  // テンポ条件。メトロノーム録音どうしなら設定 bpm を比べる(格子の絶対指標なので確実)。
  // 無ければ診断結果のテンポ差(正なら今回のほうが速い)が −8% を下回ったら「遅く弾いた」とみなす
  const curGrid = gridOf(cur)
  const prevGrid = gridOf(prev)
  const slower = curGrid && prevGrid ? curGrid.bpm < prevGrid.bpm : curDiag ? curDiag.tempoDiffPct < SLOWER_TEMPO_PCT : false

  // 1) 出だしのばらつき。両方にメトロノーム録音の格子解析があれば絶対指標どうし(公平)。
  //    無ければ直前比のばらつき(基準が動くので注記を添える)
  if (curGrid && prevGrid) {
    if (curGrid.onsetCount >= MIN_NOTES_FOR_VERDICT && prevGrid.onsetCount >= MIN_NOTES_FOR_VERDICT) {
      items.push({
        key: 'jitter',
        label: '出だしのばらつき',
        prev: prevGrid.jitterMs,
        cur: curGrid.jitterMs,
        unit: 'ms',
        outcome: outcomeOf(curGrid.jitterMs - prevGrid.jitterMs, FLAT_JITTER_MS, true),
        note: slower ? `♩=${prevGrid.bpm} → ♩=${curGrid.bpm}` : undefined,
      })
    } else {
      tooFewNotes = true
    }
  } else if (curDiag && prevDiag) {
    if (curDiag.alignedNoteCount >= MIN_NOTES_FOR_VERDICT) {
      items.push({
        key: 'jitter',
        label: '出だしのばらつき',
        prev: prevDiag.timingJitterMs,
        cur: curDiag.timingJitterMs,
        unit: 'ms',
        outcome: outcomeOf(curDiag.timingJitterMs - prevDiag.timingJitterMs, FLAT_JITTER_MS, true),
        note: '直前比',
      })
      notes.push(RELATIVE_NOTE)
    } else {
      tooFewNotes = true
    }
  }

  // 2) 一致率と弾き忘れ/余分。どちらも直前比の診断結果どうし
  if (curDiag && prevDiag) {
    if (curDiag.alignedNoteCount >= MIN_NOTES_FOR_VERDICT) {
      items.push({
        key: 'match',
        label: '音符一致率',
        prev: prevDiag.noteMatchRate * 100,
        cur: curDiag.noteMatchRate * 100,
        unit: '%',
        outcome: outcomeOf(curDiag.noteMatchRate - prevDiag.noteMatchRate, FLAT_MATCH_RATE, false),
      })
      items.push({
        key: 'missed',
        label: '弾き忘れ/余分',
        prev: prevDiag.missedOrExtraNoteCount,
        cur: curDiag.missedOrExtraNoteCount,
        unit: '',
        outcome: outcomeOfMissed(curDiag.missedOrExtraNoteCount - prevDiag.missedOrExtraNoteCount),
      })
    } else {
      tooFewNotes = true
    }
  }

  if (items.length === 0) {
    return empty(tooFewNotes ? `音数が少なく比べられません(${MIN_NOTES_FOR_VERDICT} 音未満)` : '前回のテイクとの比較結果がありません')
  }

  // 3) テンポ条件。「遅く弾いて勝つ」を防ぐ。勝ちだけを引き分けに落とし、負けはそのまま
  if (slower) {
    let demoted = false
    for (const it of items) {
      if (it.outcome === 'win') {
        it.outcome = 'draw'
        it.note = it.note ? `${it.note} · ${TEMPO_NOTE}` : TEMPO_NOTE
        demoted = true
      }
    }
    notes.push(demoted ? TEMPO_NOTE : '前回よりテンポを落として録っています')
  }

  const tally = { win: 0, draw: 0, loss: 0 }
  for (const it of items) tally[it.outcome]++
  return { eligible: true, items, tally, isDemo, notes }
}

/** 安定ゲージの目盛り数 */
export const GAUGE_MAX = 5
export type Gauge = { value: number; max: 5; available: boolean; basis: 'grid' | 'relative' | 'none' }

/** ゲージ用の「直前比のばらつき判定」1 件。判定できないときは null */
type JitterStep = { delta: number; slower: boolean; basis: 'grid' | 'relative' }

function jitterStep(cur: Take, prev: Take, prevDiagByTake: Map<string, DiagnosisResult>): JitterStep | null {
  const curGrid = gridOf(cur)
  const prevGrid = gridOf(prev)
  if (curGrid && prevGrid) {
    if (curGrid.onsetCount < MIN_NOTES_FOR_VERDICT || prevGrid.onsetCount < MIN_NOTES_FOR_VERDICT) return null
    return { delta: curGrid.jitterMs - prevGrid.jitterMs, slower: curGrid.bpm < prevGrid.bpm, basis: 'grid' }
  }
  // compareMode 'prev' の保存結果だけを使う。お手本(reference)との比較値は基準が別物なので混ぜない
  const curDiag = prevDiagByTake.get(cur.id)
  const prevDiag = prevDiagByTake.get(prev.id)
  if (!curDiag || !prevDiag || curDiag.compareMode !== 'prev' || prevDiag.compareMode !== 'prev') return null
  if (curDiag.alignedNoteCount < MIN_NOTES_FOR_VERDICT) return null
  return {
    delta: curDiag.timingJitterMs - prevDiag.timingJitterMs,
    slower: curDiag.tempoDiffPct < SLOWER_TEMPO_PCT,
    basis: 'relative',
  }
}

/** ゲージが対象にするテイク列に絞る(昇順は呼び出し側の責任だが、念のため並べ直す) */
function normalTakesAsc(takes: Take[]): Take[] {
  return takes.filter((t) => t.role === 'normal' && !!t.noteEvents).sort((a, b) => a.recordedAt - b.recordedAt)
}

/**
 * 安定ゲージ。昇順の normal テイク列(noteEvents あり)と、takeId → prev モードの診断結果。
 * 各テイクの直前比のばらつき判定を走査し、win/draw で +1、loss かつ Δ > 3×FLAT_JITTER_MS で −1、
 * それ以外(小さな負け・テンポを落とした回・判定不能)は 0。0〜GAUGE_MAX でクランプ。
 * 判定できたペアが 1 つも無ければ(判定できるテイクが 2 本未満)available: false。
 */
export function stabilityGauge(takesAsc: Take[], prevDiagByTake: Map<string, DiagnosisResult>): Gauge {
  const takes = normalTakesAsc(takesAsc)
  let value = 0
  let judged = 0
  let basis: Gauge['basis'] = 'none'
  for (let i = 1; i < takes.length; i++) {
    const step = jitterStep(takes[i], takes[i - 1], prevDiagByTake)
    if (!step) continue
    judged++
    basis = step.basis
    if (step.slower) continue // テンポを落として揃えた回は数えない(加算も減算もしない)
    const outcome = outcomeOf(step.delta, FLAT_JITTER_MS, true)
    if (outcome === 'win' || outcome === 'draw') value++
    else if (step.delta > 3 * FLAT_JITTER_MS) value--
    value = Math.min(GAUGE_MAX, Math.max(0, value))
  }
  return { value, max: GAUGE_MAX, available: judged >= 1, basis }
}

/**
 * 直近の連敗数(ばらつき項目の loss が、指定テイクから遡って何回続いているか)。
 * VersusCard が 3 以上のとき勝敗マークを出さずに文言を切り替えるために使う。
 * 判定できないテイクに当たったら連敗は途切れたものとして数えるのをやめる。
 */
export function consecutiveJitterLosses(takesAsc: Take[], prevDiagByTake: Map<string, DiagnosisResult>, upToTakeId: string): number {
  const takes = normalTakesAsc(takesAsc)
  let idx = takes.findIndex((t) => t.id === upToTakeId)
  if (idx < 0) idx = takes.length - 1
  let losses = 0
  for (let i = idx; i >= 1; i--) {
    const step = jitterStep(takes[i], takes[i - 1], prevDiagByTake)
    if (!step) break
    if (outcomeOf(step.delta, FLAT_JITTER_MS, true) !== 'loss') break
    losses++
  }
  return losses
}

/** 発見の 1 行(可変報酬)。型を 6 個用意し、条件に合う中から直近と違う型を選ぶ */
export type Discovery = { kind: 'best' | 'weekAgo' | 'firstTake' | 'sameTempo' | 'count' | 'setback'; text: string }

/** テイク 1 本の「ばらつき」。格子解析があれば絶対指標、無ければ直前比。混ぜて比べないよう basis を持つ */
export type JitterValue = { value: number; basis: 'grid' | 'relative'; bpm?: number }

export function jitterValueOf(t: Take, prevDiagByTake: Map<string, DiagnosisResult>): JitterValue | null {
  const g = gridOf(t)
  if (g) return g.onsetCount >= MIN_NOTES_FOR_VERDICT ? { value: g.jitterMs, basis: 'grid', bpm: g.bpm } : null
  const d = prevDiagByTake.get(t.id)
  if (!d || d.compareMode !== 'prev' || d.alignedNoteCount < MIN_NOTES_FOR_VERDICT) return null
  return { value: d.timingJitterMs, basis: 'relative' }
}

function ms(v: number) {
  return `${Math.round(v)}ms`
}

function md(ts: number) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 「◯ms 小さい / ◯ms ばらついた / 横ばい」を数値と方向だけで言う。「上達」「良くなった」は使わない */
function deltaPhrase(from: number, to: number): string {
  const d = to - from
  if (Math.abs(d) < FLAT_JITTER_MS - EPS) return `横ばい(${ms(from)} → ${ms(to)})`
  return d < 0 ? `${ms(-d)} 小さい(${ms(from)} → ${ms(to)})` : `${ms(d)} ばらついた(${ms(from)} → ${ms(to)})`
}

/** 月曜 0:00 を週の始まりとする(ローカル) */
function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts))
  const dow = (d.getDay() + 6) % 7 // 月=0 … 日=6
  d.setDate(d.getDate() - dow)
  return d.getTime()
}

export function pickDiscovery(args: {
  thread: Thread
  takesAsc: Take[]
  cur: Take
  verdict: Verdict
  prevDiagByTake: Map<string, DiagnosisResult>
}): Discovery | null {
  const { thread, cur, verdict, prevDiagByTake } = args
  const takes = normalTakesAsc(args.takesAsc)
  const curIdx = takes.findIndex((t) => t.id === cur.id)
  const earlier = curIdx >= 0 ? takes.slice(0, curIdx) : takes.filter((t) => t.recordedAt < cur.recordedAt)
  const curJ = jitterValueOf(cur, prevDiagByTake)
  // 同じ basis の過去テイクだけを比較対象にする(格子の絶対値と直前比の値は別物)
  const comparable = curJ
    ? earlier.map((t) => ({ take: t, j: jitterValueOf(t, prevDiagByTake) })).filter((x): x is { take: Take; j: JitterValue } => !!x.j && x.j.basis === curJ.basis)
    : []
  const candidates: Discovery[] = []

  // 1) 過去ベスト更新(該当すれば必ず出す)
  if (curJ && comparable.length >= 2) {
    const prevBest = Math.min(...comparable.map((x) => x.j.value))
    if (curJ.value < prevBest) {
      const flat = prevBest - curJ.value < FLAT_JITTER_MS - EPS
      return {
        kind: 'best',
        text: flat
          ? `これまでのいちばん小さいばらつき(${ms(prevBest)})と横ばい(${ms(curJ.value)})`
          : `これまででいちばん小さいばらつき(前ベスト ${ms(prevBest)} → ${ms(curJ.value)})`,
      }
    }
  }

  // 2) 前回よりばらついた(悪い日も事実で出す)
  const jitterItem = verdict.items.find((it) => it.key === 'jitter')
  if (jitterItem && jitterItem.outcome === 'loss') {
    candidates.push({ kind: 'setback', text: `前回より ${ms(jitterItem.cur - jitterItem.prev)} ばらついた(${ms(jitterItem.prev)} → ${ms(jitterItem.cur)})` })
  }

  // 3) 1 週間前(5〜10 日前で最も 7 日前に近いテイク)との差
  if (curJ) {
    const target = cur.recordedAt - 7 * 86_400_000
    const around = comparable
      .filter((x) => {
        const d = daysSince(x.take.recordedAt, cur.recordedAt)
        return d >= 5 && d <= 10
      })
      .sort((a, b) => Math.abs(a.take.recordedAt - target) - Math.abs(b.take.recordedAt - target))
    if (around.length > 0) {
      const w = around[0]
      candidates.push({ kind: 'weekAgo', text: `1 週間前(${md(w.take.recordedAt)})より ${deltaPhrase(w.j.value, curJ.value)}` })
    }
  }

  // 4) 同じ BPM の前回との比較(直前テイクの BPM が違うときだけ意味がある)
  if (curJ && curJ.basis === 'grid' && curJ.bpm !== undefined) {
    const prev = earlier[earlier.length - 1]
    const prevJ = prev ? jitterValueOf(prev, prevDiagByTake) : null
    if (prevJ && prevJ.bpm !== curJ.bpm) {
      const same = [...comparable].reverse().find((x) => x.j.bpm === curJ.bpm)
      if (same) {
        candidates.push({ kind: 'sameTempo', text: `同じ ♩=${curJ.bpm} の前回(${md(same.take.recordedAt)})より ${deltaPhrase(same.j.value, curJ.value)}` })
      }
    }
  }

  // 5) 初テイクからの日数と差
  if (curJ && comparable.length >= 1) {
    const first = comparable[0]
    const days = daysSince(first.take.recordedAt, cur.recordedAt)
    if (days >= 1) {
      const since = Math.max(days, daysSince(thread.createdAt, cur.recordedAt))
      candidates.push({ kind: 'firstTake', text: `初テイク(${md(first.take.recordedAt)}、${since} 日前)より ${deltaPhrase(first.j.value, curJ.value)}` })
    }
  }

  // 6) 今週このスレッドで N 本目
  const weekStart = startOfWeek(cur.recordedAt)
  const n = takes.filter((t) => t.recordedAt >= weekStart && t.recordedAt <= cur.recordedAt).length
  if (n >= 2) candidates.push({ kind: 'count', text: `今週このスレッドで ${n} 本目` })

  if (candidates.length === 0) return null
  // 直近と違う型を出したいが、保存は持たないので「何本目か」で巡回する。同じ入力なら同じ結果になる
  const seq = curIdx >= 0 ? curIdx : takes.length
  return candidates[seq % candidates.length]
}

/**
 * hero 選定・まとめ用: 各スレッドの直近テイクの判定(WP-B / WP-C が使う)。
 * 1 スレッド 1 値。jitter 項目があればその勝敗、無ければ tally の多数決(同数は draw)。判定不能は 'n/a'
 */
export function latestOutcomeByThread(takesAsc: Take[], prevDiagByTake: Map<string, DiagnosisResult>): Map<string, Outcome | 'n/a'> {
  const byThread = new Map<string, Take[]>()
  for (const t of normalTakesAsc(takesAsc)) {
    const list = byThread.get(t.threadId)
    if (list) list.push(t)
    else byThread.set(t.threadId, [t])
  }
  const out = new Map<string, Outcome | 'n/a'>()
  for (const [threadId, list] of byThread) {
    const cur = list[list.length - 1]
    const prev = list[list.length - 2]
    const v = judgeAgainstPrev({
      cur,
      prev,
      curDiag: prevModeOnly(prevDiagByTake.get(cur.id)),
      prevDiag: prev ? prevModeOnly(prevDiagByTake.get(prev.id)) : undefined,
    })
    out.set(threadId, overallOutcome(v))
  }
  return out
}

/** compareMode 'prev' 以外の保存結果(お手本比較)は使わない */
function prevModeOnly(d: DiagnosisResult | undefined): DiagnosisResult | undefined {
  return d && d.compareMode === 'prev' ? d : undefined
}

/** Verdict を 1 語に畳む。jitter 優先、無ければ多数決 */
export function overallOutcome(v: Verdict): Outcome | 'n/a' {
  if (!v.eligible) return 'n/a'
  const jitter = v.items.find((it) => it.key === 'jitter')
  if (jitter) return jitter.outcome
  if (v.tally.win > v.tally.loss) return 'win'
  if (v.tally.loss > v.tally.win) return 'loss'
  return 'draw'
}
