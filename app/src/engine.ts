import { getRemoteTranscribeUrl } from './remoteTranscribe'

// 音符起こしのエンジン選択。
//   basic-pitch: 従来(TF.js、0.74 MB、GAPS test F1 81%)
//   student:     GAPS 論文の公開モデルを蒸留した小型 CRNN(ONNX Runtime Web、4 MB、GAPS 86% / GuitarSet 86%。studentTranscribe.ts)
//   remote:      公開モデルそのものを Mac の Python で動かす暫定手段(remoteTranscribe.ts)。URL が設定されていれば最優先
// 設定は端末ごと(localStorage)。検証画面「0. 推論エンジン」で切り替える
export type TranscribeEngine = 'basic-pitch' | 'student' | 'remote'
const KEY = 'transcribeEngine'

export function getTranscribeEngine(): TranscribeEngine {
  if (getRemoteTranscribeUrl()) return 'remote'
  try {
    return localStorage.getItem(KEY) === 'student' ? 'student' : 'basic-pitch'
  } catch {
    return 'basic-pitch'
  }
}

export function setLocalEngine(engine: 'basic-pitch' | 'student'): void {
  try {
    if (engine === 'student') localStorage.setItem(KEY, 'student')
    else localStorage.removeItem(KEY)
  } catch {
    // localStorage が使えない環境では既定(basic-pitch)のまま
  }
}
