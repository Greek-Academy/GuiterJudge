import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { requestPersistentStorage } from './backup.ts'

// データ消失リスク(サイト削除・OSのストレージ自動削除)への緩和策。完全な保証ではない。
requestPersistentStorage().then((granted) => {
  console.log(granted ? 'Persistent storage granted' : 'Persistent storage not granted (or unsupported)')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
