import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { requestPersistentStorage } from './backup.ts'
import { warmUpModel } from './basicPitch.ts'

// データ消失リスク(サイト削除・OSのストレージ自動削除)への緩和策。完全な保証ではない。
requestPersistentStorage().then((granted) => {
  console.log(granted ? 'Persistent storage granted' : 'Persistent storage not granted (or unsupported)')
})

// 音符起こしモデルのウォームアップ。M1実測で初回推論に約8秒かかるため、
// ユーザーが最初に録音するまでの間に裏で済ませておく。
// 初期表示を遅らせないよう、描画後の暇な時間に回す(requestIdleCallbackが無い環境ではsetTimeout)。
const scheduleIdle: (cb: () => void) => void =
  typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(cb, { timeout: 5000 })
    : (cb) => setTimeout(cb, 1500)
scheduleIdle(() => {
  void warmUpModel()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
