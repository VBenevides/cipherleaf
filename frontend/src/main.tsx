import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import Scratchpad from './Scratchpad'

const root = document.getElementById('root') as HTMLElement
const scratchpadWindow = new URLSearchParams(window.location.search).get('window') === 'scratchpad'

if (scratchpadWindow) {
  document.documentElement.dataset.window = 'scratchpad'
  root.dataset.window = 'scratchpad'
  const theme = window.localStorage.getItem('cipherleaf-theme')
  if (theme === 'light' || theme === 'dark' || theme === 'archivist') {
    document.documentElement.dataset.theme = theme
  }
  const size = Number(window.localStorage.getItem('cipherleaf-editor-font-size'))
  if (Number.isFinite(size) && size >= 10 && size <= 32) {
    document.documentElement.style.setProperty('--editor-font-size', `${size}px`)
  }
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {scratchpadWindow ? <Scratchpad overlay /> : <App />}
  </React.StrictMode>,
)
