import type { NoteEvent } from './db'

// リモート推論(train/serve_transcribe.py)。GAPS 論文の公開モデル(Kong et al. の CRNN を GAPS で学習、
// 音符 F1 は GAPS test 94.7% / GuitarSet 90.4%。Basic Pitch は 81 / 82%)を Mac 上の Python で動かし、
// ブラウザは前処理済み(22050Hz モノラル)の PCM を送って音符列だけ受け取る。
// 蒸留した小型モデルをブラウザに載せるまでの暫定手段で、URL が設定されているときだけ transcribe() がこちらを使う。
// オフラインでは動かず、録音を端末外(自分の Mac)に送ることになる。設定は localStorage に置く(端末ごと)。

const KEY = 'remoteTranscribeUrl'

export function getRemoteTranscribeUrl(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function setRemoteTranscribeUrl(url: string): void {
  try {
    const u = url.trim()
    if (u) localStorage.setItem(KEY, u)
    else localStorage.removeItem(KEY)
  } catch {
    // プライベートモードなどで localStorage が使えない場合は設定できないだけ
  }
}

export type RemoteTranscription = {
  notes: NoteEvent[]
  inferenceMs: number
  model: string
}

/** 前処理済みバッファ(preprocessForAnalysis の出力)をそのまま送る。時刻はバッファ先頭基準で返る(analysisOffsetMs は呼び出し側で足す) */
export async function transcribeRemote(analysisBuffer: AudioBuffer, url: string = getRemoteTranscribeUrl()): Promise<RemoteTranscription> {
  if (!url) throw new Error('リモート推論の URL が設定されていません')
  const pcm = analysisBuffer.getChannelData(0)
  const body = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer
  const res = await fetch(url.replace(/\/+$/, '') + '/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(analysisBuffer.sampleRate) },
    body,
  })
  if (!res.ok) throw new Error(`リモート推論に失敗しました (HTTP ${res.status})`)
  const j = (await res.json()) as { notes: NoteEvent[]; inferenceMs: number; model: string }
  const notes: NoteEvent[] = j.notes
    .map((n) => ({ pitch: n.pitch, startMs: n.startMs, durationMs: n.durationMs, velocity: n.velocity }))
    .sort((a, b) => a.startMs - b.startMs)
  return { notes, inferenceMs: j.inferenceMs, model: j.model }
}
