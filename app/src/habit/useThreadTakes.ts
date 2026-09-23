import { useLiveQuery } from 'dexie-react-hooks'
import db, { type Take, type Thread, type DiagnosisResult } from '../db'

// 「毎日の型」の 3 パッケージ(判定・ホーム・締め)が同じクエリを別々に書かないための共通フック。
// 読み取りだけ。書き込みは actions.ts のユースケース関数を通す(ここには置かない)。
//
// 返す Map は takeId → compareMode 'prev' の保存済み診断だけ。お手本(reference)との比較値は
// 基準が別物なので、勝敗やゲージに混ぜない(verdict.ts 側でも二重に弾いている)。
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
  const prevDiagByTake = useLiveQuery(async () => {
    const ids = (await db.takes.where({ threadId }).primaryKeys()) as string[]
    if (ids.length === 0) return new Map<string, DiagnosisResult>()
    return prevMapOf(await db.diagnosisResults.where('takeId').anyOf(ids).toArray())
  }, [threadId])
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
  const prevDiagByTake = useLiveQuery(async () => prevMapOf(await db.diagnosisResults.toArray()), [])
  return { threads, takesAsc, prevDiagByTake }
}
