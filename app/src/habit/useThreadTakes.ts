import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import db, { type Take, type Thread, type DiagnosisResult } from '../db'
import { withPrevDiags } from './verdict'

// 「毎日の型」の 3 パッケージ(判定・ホーム・締め)が同じクエリを別々に書かないための共通フック。
// 読み取りだけ。書き込みは actions.ts のユースケース関数を通す(ここには置かない)。
//
// 返す Map は takeId → compareMode 'prev' の診断。保存済みの prev があればそれ、無ければ(お手本ありスレッドや
// best / reference で再計算したテイク)直前テイクとその場で計算した値(verdict.withPrevDiags、メモ化あり)。
// 対戦カード・ゲージ・hero・まとめ・もう 1 回バーが同じ判定源を見るよう、ここで 1 度だけ埋めて配る。
// お手本(reference)との比較値は基準が別物なので、勝敗やゲージに混ぜない(verdict.ts 側でも二重に弾いている)。
// 返り値が undefined の間は読み込み中。

/** 保存済み診断のうち直前比(prev)だけを takeId で引けるようにする */
function prevMapOf(results: DiagnosisResult[]): Map<string, DiagnosisResult> {
  const map = new Map<string, DiagnosisResult>()
  for (const r of results) if (r.compareMode === 'prev') map.set(r.takeId, r)
  return map
}

/** スレッドの normal テイク(recordedAt 昇順、noteEvents あり)と、takeId → prev モードの保存済み診断 */
export function useThreadTakesAsc(threadId: string): {
  takesAsc: Take[] | undefined
  prevDiagByTake: Map<string, DiagnosisResult> | undefined
} {
  const takesAsc = useLiveQuery(
    async () => (await db.takes.where({ threadId, role: 'normal' }).sortBy('recordedAt')).filter((t) => !!t.noteEvents),
    [threadId],
  )
  const savedPrevDiagByTake = useLiveQuery(async () => {
    const ids = (await db.takes.where({ threadId }).primaryKeys()) as string[]
    if (ids.length === 0) return new Map<string, DiagnosisResult>()
    return prevMapOf(await db.diagnosisResults.where('takeId').anyOf(ids).toArray())
  }, [threadId])
  const prevDiagByTake = useMemo(
    () => (takesAsc && savedPrevDiagByTake ? withPrevDiags(takesAsc, savedPrevDiagByTake) : undefined),
    [takesAsc, savedPrevDiagByTake],
  )
  return { takesAsc, prevDiagByTake }
}

/** 全スレッド分。ホーム(今日の一本・まとめ)用 */
export function useAllHabitData(): {
  threads: Thread[] | undefined
  takesAsc: Take[] | undefined
  prevDiagByTake: Map<string, DiagnosisResult> | undefined
} {
  const threads = useLiveQuery(() => db.threads.toArray(), [])
  const takesAsc = useLiveQuery(
    async () => (await db.takes.where('role').equals('normal').sortBy('recordedAt')).filter((t) => !!t.noteEvents),
    [],
  )
  const savedPrevDiagByTake = useLiveQuery(async () => prevMapOf(await db.diagnosisResults.toArray()), [])
  const prevDiagByTake = useMemo(
    () => (takesAsc && savedPrevDiagByTake ? withPrevDiags(takesAsc, savedPrevDiagByTake) : undefined),
    [takesAsc, savedPrevDiagByTake],
  )
  return { threads, takesAsc, prevDiagByTake }
}
