import { useState } from 'react'
import './App.css'
import ThreadList from './screens/ThreadList'
import ThreadDetail from './screens/ThreadDetail'
import DiagnosisView from './screens/DiagnosisView'
import SongThroughView from './screens/SongThroughView'
import TranscriptionLab from './screens/TranscriptionLab'

type Screen =
  | { name: 'list' }
  /** autoRecord: 「今日の一本」「もう 1 回」から来たとき。マイク許可済みなら開いた直後に録音を始める */
  | { name: 'thread'; threadId: string; autoRecord?: boolean }
  | { name: 'diagnosis'; threadId: string; takeId: string }
  | { name: 'songThrough'; threadId: string }
  | { name: 'lab' }

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'list' })

  return (
    <div className="phone">
      {screen.name === 'list' && (
        <ThreadList
          onOpenThread={(threadId) => setScreen({ name: 'thread', threadId })}
          onRecordNow={(threadId) => setScreen({ name: 'thread', threadId, autoRecord: true })}
          onOpenSongThrough={(threadId) => setScreen({ name: 'songThrough', threadId })}
          onOpenLab={() => setScreen({ name: 'lab' })}
        />
      )}
      {screen.name === 'lab' && <TranscriptionLab onBack={() => setScreen({ name: 'list' })} />}
      {screen.name === 'thread' && (
        <ThreadDetail
          threadId={screen.threadId}
          autoRecord={screen.autoRecord === true}
          onBack={() => setScreen({ name: 'list' })}
          onOpenDiagnosis={(takeId) => setScreen({ name: 'diagnosis', threadId: screen.threadId, takeId })}
        />
      )}
      {screen.name === 'diagnosis' && (
        <DiagnosisView
          threadId={screen.threadId}
          takeId={screen.takeId}
          onBack={() => setScreen({ name: 'thread', threadId: screen.threadId })}
          onRecordAgain={() => setScreen({ name: 'thread', threadId: screen.threadId, autoRecord: true })}
          onGoHome={() => setScreen({ name: 'list' })}
        />
      )}
      {screen.name === 'songThrough' && (
        <SongThroughView threadId={screen.threadId} onBack={() => setScreen({ name: 'list' })} />
      )}
    </div>
  )
}

export default App
