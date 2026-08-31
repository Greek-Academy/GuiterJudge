import db from './db'

// データ消失リスク(サイト削除・OSのストレージ自動削除)への対策として、
// バックエンドを持たない設計のままユーザー自身が任意のタイミングでバックアップを取れるようにする。
// 新規ライブラリは使わず、Blobをbase64化してJSON1ファイルにまとめる素朴な方式(個人利用規模の容量なら十分)。

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

export async function exportAllData(): Promise<void> {
  const [threads, takes, diagnosisResults, songThroughCompletions] = await Promise.all([
    db.threads.toArray(),
    db.takes.toArray(),
    db.diagnosisResults.toArray(),
    db.songThroughCompletions.toArray(),
  ])

  const takesSerialized = await Promise.all(
    takes.map(async (t) => ({
      ...t,
      audioBlob: undefined,
      audioBlobBase64: await blobToBase64(t.audioBlob),
      audioBlobType: t.audioBlob.type,
    })),
  )

  const payload = {
    exportedAt: Date.now(),
    version: 1,
    threads,
    takes: takesSerialized,
    diagnosisResults,
    songThroughCompletions,
  }

  const json = JSON.stringify(payload)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `guitar-diagnosis-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** 既存データは残したまま、バックアップファイルの内容を追加でインポートする */
export async function importAllData(file: File): Promise<{ threadCount: number; takeCount: number }> {
  const text = await file.text()
  const payload = JSON.parse(text)

  const takes = await Promise.all(
    (payload.takes as any[]).map(async (t) => ({
      ...t,
      audioBlob: base64ToBlob(t.audioBlobBase64, t.audioBlobType),
      audioBlobBase64: undefined,
      audioBlobType: undefined,
    })),
  )

  await db.transaction('rw', db.threads, db.takes, db.diagnosisResults, db.songThroughCompletions, async () => {
    await db.threads.bulkPut(payload.threads)
    await db.takes.bulkPut(takes)
    await db.diagnosisResults.bulkPut(payload.diagnosisResults)
    await db.songThroughCompletions.bulkPut(payload.songThroughCompletions)
  })

  return { threadCount: payload.threads.length, takeCount: takes.length }
}

/**
 * ブラウザに「このオリジンのストレージは自動削除しないでほしい」と要求する。
 * 完全な保証ではないが、iOS Safari等のストレージ逼迫時の自動削除リスクを下げる。
 * アプリ起動時に一度呼ぶ想定。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  const alreadyPersisted = await navigator.storage.persisted?.()
  if (alreadyPersisted) return true
  return navigator.storage.persist()
}
