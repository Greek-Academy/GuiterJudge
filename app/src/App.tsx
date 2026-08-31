import { useState } from 'react'
import './App.css'
import ThreadList from './screens/ThreadList'
import ThreadDetail from './screens/ThreadDetail'
import DiagnosisView from './screens/DiagnosisView'
import SongThroughView from './screens/SongThroughView'
import TranscriptionLab from './screens/TranscriptionLab'

type Screen =
  | { name: 'list' }
  | { name: 'thread'; threadId: string }
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
          onOpenSongThrough={(threadId) => setScreen({ name: 'songThrough', threadId })}
          onOpenLab={() => setScreen({ name: 'lab' })}
        />
      )}
      {screen.name === 'lab' && <TranscriptionLab onBack={() => setScreen({ name: 'list' })} />}
      {screen.name === 'thread' && (
        <ThreadDetail
          threadId={screen.threadId}
          onBack={() => setScreen({ name: 'list' })}
          onOpenDiagnosis={(takeId) => setScreen({ name: 'diagnosis', threadId: screen.threadId, takeId })}
        />
      )}
      {screen.name === 'diagnosis' && (
        <DiagnosisView
          threadId={screen.threadId}
          takeId={screen.takeId}
          onBack={() => setScreen({ name: 'thread', threadId: screen.threadId })}
        />
      )}
      {screen.name === 'songThrough' && (
        <SongThroughView threadId={screen.threadId} onBack={() => setScreen({ name: 'list' })} />
      )}
    </div>
  )
}

export default App
