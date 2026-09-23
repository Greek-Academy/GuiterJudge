import { useMemo } from 'react'
import { useThreadTakesAsc } from '../habit/useThreadTakes'
import { todaysHabitTakes } from '../habit/dailyStats'
import { jitterValueOf } from '../habit/verdict'

// 診断画面の最下部に貼り付く「もう 1 回」バー。遷移するだけで busy の概念は持たない。
// 上段は今日このスレッドで録った本数と、ばらつきの並び(メトロノーム録音なら格子の絶対値、無ければ直前比)。
// デモテイクは「今日」に数えない(isHabitTake)。

type Props = { threadId: string; onRecordAgain: () => void; onGoHome: () => void }

/** 並べる値の最大本数。420px 幅で「24 → 19 → 17 → 21 → 18ms」まで */
const MAX_TREND_VALUES = 5

export default function RecordAgainBar({ threadId, onRecordAgain, onGoHome }: Props) {
  const { takesAsc, prevDiagByTake } = useThreadTakesAsc(threadId)

  const trend = useMemo(() => {
    if (!takesAsc || !prevDiagByTake) return null
    const today = todaysHabitTakes(takesAsc)
    if (today.length === 0) return { count: 0, values: null as string | null }
    const js = today.map((t) => jitterValueOf(t, prevDiagByTake))
    // 全部に値があり、基準(格子 / 直前比)が揃っているときだけ数字を並べる。混ぜると別物の数字が並ぶ
    const allSame = js.every((j) => j && j.basis === js[0]!.basis)
    if (!allSame) return { count: today.length, values: null }
    const shown = js.slice(-MAX_TREND_VALUES).map((j) => String(Math.round(j!.value)))
    const prefix = js.length > MAX_TREND_VALUES ? '… ' : ''
    return { count: today.length, values: `${prefix}${shown.join(' → ')}ms` }
  }, [takesAsc, prevDiagByTake])

  return (
    <div className="again-bar">
      <div className="mini-trend">
        {trend === null ? (
          ' '
        ) : trend.count === 0 ? (
          '今日はまだこのフレーズを録っていません'
        ) : (
          <>
            今日 <span className="n">{trend.count} テイク目</span>
            {trend.values && <> · {trend.values}</>}
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
