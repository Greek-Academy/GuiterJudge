import { useMemo } from 'react'
import { useThreadTakesAsc } from '../habit/useThreadTakes'
import { isHabitTake, startOfDay, todaysHabitTakes } from '../habit/dailyStats'
import { jitterValueOf } from '../habit/verdict'

// 診断画面の最下部に貼り付く「もう 1 回」バー。遷移するだけで busy の概念は持たない。
// 上段は「表示中のテイクがその日このスレッドで何本目か」と、その日のそこまでのばらつきの並び
// (メトロノーム録音なら格子の絶対値、無ければ直前比)。
// 過去の日のテイクを開いたときは「9/21 の 3 テイク目」とその日の日付で言い、今日の本数は別に明記する
// (「今日 N テイク目」は今日のテイクを見ているときだけ)。デモテイクは日集計に数えない(isHabitTake)。

type Props = { threadId: string; takeId: string; onRecordAgain: () => void; onGoHome: () => void }

/** 並べる値の最大本数。420px 幅で「24 → 19 → 17 → 21 → 18ms」まで */
const MAX_TREND_VALUES = 5

function md(ts: number) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

type Line = {
  /** 「今日 3 テイク目」「9/21 の 3 テイク目」。表示中のテイクが日集計の対象外(デモ等)なら null */
  ordinal: string | null
  /** ばらつきの並び(基準が揃っているときだけ) */
  values: string | null
  /** 補足(今日の総本数など)。無ければ null */
  aside: string | null
}

export default function RecordAgainBar({ threadId, takeId, onRecordAgain, onGoHome }: Props) {
  const { takesAsc, prevDiagByTake } = useThreadTakesAsc(threadId)

  const line = useMemo((): Line | null => {
    if (!takesAsc || !prevDiagByTake) return null
    const now = Date.now()
    const todayCount = todaysHabitTakes(takesAsc, now).length
    const take = takesAsc.find((t) => t.id === takeId)
    if (!take || !isHabitTake(take)) {
      // デモテイクなど日集計に入らないテイク。順番は言わず、今日の本数だけ
      const aside = todayCount === 0 ? '今日はまだこのフレーズを録っていません' : `今日このフレーズで ${todayCount} 本`
      return { ordinal: null, values: null, aside }
    }

    // 表示中のテイクが属する日の habit テイク(昇順)と、その中での順番
    const day = todaysHabitTakes(takesAsc, take.recordedAt)
    const idx = day.findIndex((t) => t.id === take.id)
    const upTo = day.slice(0, idx + 1)
    const isToday = startOfDay(take.recordedAt) === startOfDay(now)
    const ordinal = `${isToday ? '今日' : `${md(take.recordedAt)} の`} ${idx + 1} テイク目`

    // その日のそこまでの並び。全部に値があり、基準(格子 / 直前比)が揃っているときだけ数字を並べる
    const js = upTo.map((t) => jitterValueOf(t, prevDiagByTake))
    const allSame = js.every((j) => j && j.basis === js[0]!.basis)
    let values: string | null = null
    if (allSame) {
      const shown = js.slice(-MAX_TREND_VALUES).map((j) => String(Math.round(j!.value)))
      values = `${js.length > MAX_TREND_VALUES ? '… ' : ''}${shown.join(' → ')}ms`
    }

    // 今日の最新テイクを見ているなら補足は要らない。今日の途中のテイクや過去の日なら今日の本数を別に書く
    let aside: string | null = null
    if (!isToday) aside = todayCount === 0 ? '今日はまだ録っていません' : `今日は ${todayCount} 本`
    else if (idx + 1 < todayCount) aside = `今日は計 ${todayCount} 本`
    return { ordinal, values, aside }
  }, [takesAsc, prevDiagByTake, takeId])

  return (
    <div className="again-bar">
      <div className="mini-trend">
        {line === null ? (
          ' '
        ) : (
          <>
            {line.ordinal && <span className="n">{line.ordinal}</span>}
            {line.ordinal && line.values && <> · {line.values}</>}
            {line.aside && <>{line.ordinal ? `(${line.aside})` : line.aside}</>}
          </>
        )}
      </div>
      <div className="btns">
        <button className="primary" onClick={onRecordAgain}>
          ● もう 1 回録る
        </button>
        <button className="secondary" onClick={onGoHome}>
          一覧へ
        </button>
      </div>
    </div>
  )
}
