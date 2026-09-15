import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './i18n'
import './styles/themes.css'
import './styles/app.css'
import { applyThemeSetting } from './theme'
import ScriptPlayerStandalone from '@script-player/interface/renderer/ScriptPlayerStandalone'
import VideoPlayerWindow from './components/VideoPlayerWindow'

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
    ) : (
      <App />
    )}
  </React.StrictMode>
)
