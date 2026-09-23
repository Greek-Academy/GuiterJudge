import { useSyncExternalStore } from 'react'
import { notifyHabitStorage, subscribeHabitStorage } from './nextChallenge'

// 「今日のまとめ」を「今日はここまで」で畳んだ日を覚える(C11)。
// 値は畳んだ日の 'YYYY-MM-DD' 1 つだけ。翌日になれば自然に一致しなくなり、まとめが再び出る。
// 端末ごとの一時的な状態なので localStorage(バックアップ対象にしない)。

const KEY = 'habit.summaryDismissed'

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function isSummaryDismissed(dayKey: string): boolean {
  return readRaw() === dayKey
}

export function dismissSummary(dayKey: string): void {
  try {
    localStorage.setItem(KEY, dayKey)
  } catch {
    // localStorage が使えない環境では畳めないだけ(次の描画でまた出る)
  }
  notifyHabitStorage()
}

/** その日のまとめを畳んだか。同じタブ内の dismissSummary にも追従する */
export function useSummaryDismissed(dayKey: string): boolean {
  const raw = useSyncExternalStore(subscribeHabitStorage, readRaw, () => null)
  return raw === dayKey
}
