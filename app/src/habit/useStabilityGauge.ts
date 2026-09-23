import { useMemo } from 'react'
import { useThreadTakesAsc } from './useThreadTakes'
import { stabilityGauge, GAUGE_MAX, type Gauge } from './verdict'

// 安定ゲージの購読フック。StabilityGauge(表示)と ThreadDetail(解決ボタンの昇格)が同じ値を見る。
// コンポーネントファイルに置くと Fast Refresh の警告(only-export-components)が出るので habit/ に置く。

const LOADING: Gauge = { value: 0, max: GAUGE_MAX, available: false, basis: 'none' }

/** 読み込み中は available: false */
export function useStabilityGauge(threadId: string): Gauge {
  const { takesAsc, prevDiagByTake } = useThreadTakesAsc(threadId)
  return useMemo(() => (takesAsc && prevDiagByTake ? stabilityGauge(takesAsc, prevDiagByTake) : LOADING), [takesAsc, prevDiagByTake])
}
