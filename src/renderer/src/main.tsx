import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './i18n'
import './styles/themes.css'
import './styles/app.css'
import { applyThemeSetting } from './theme'
import ScriptPlayerStandalone from '@script-player/interface/renderer/ScriptPlayerStandalone'
import VideoPlayerWindow from './components/VideoPlayerWindow'

// Their own chunks: each VR page's stylesheet sizes the whole page for the
// headset, and must never reach the main window.
const VrPanel = React.lazy(() => import('./vr/VrPanel'))
const VrScriptPlayer = React.lazy(() => import('./vr/VrScriptPlayer'))

// System theme immediately (before first paint); the persisted ui.theme
// setting is applied by App once settings arrive over IPC.
applyThemeSetting('system')

const query = new URLSearchParams(window.location.search)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {query.has('scriptPlayerWindow') ? (
      <ScriptPlayerStandalone />
    ) : query.has('videoPlayerWindow') ? (
      <VideoPlayerWindow />
    ) : query.has('vrPanel') ? (
      <React.Suspense fallback={null}>
        <VrPanel />
      </React.Suspense>
    ) : query.has('vrScriptPlayer') ? (
      <React.Suspense fallback={null}>
        <VrScriptPlayer />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
)
