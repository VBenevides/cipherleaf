import React from 'react'
import ReactDOM from 'react-dom/client'
import { System } from '@wailsio/runtime'
import App from './App'
import Scratchpad from './Scratchpad'

const root = document.getElementById('root') as HTMLElement
const scratchpadWindow = new URLSearchParams(window.location.search).get('window') === 'scratchpad'

if (System.IsMac()) {
  document.documentElement.dataset.os = 'darwin'
}

const SCRATCHPAD_THEME_KEY = 'cipherleaf-theme'
const SCRATCHPAD_OPACITY_KEY = 'cipherleaf-scratchpad-opacity'
const SCRATCHPAD_DEFAULT_OPACITY = 0.5

function parseScratchpadTheme(saved: string | null): 'light' | 'dark' | 'archivist' | null {
  return saved === 'light' || saved === 'dark' || saved === 'archivist' ? saved : null
}

function parseScratchpadOpacity(saved: string | null): number {
  if (saved === null || saved.trim() === '') return SCRATCHPAD_DEFAULT_OPACITY
  const opacity = Number(saved)
  return Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : SCRATCHPAD_DEFAULT_OPACITY
}

if (scratchpadWindow) {
  document.documentElement.dataset.window = 'scratchpad'
  root.dataset.window = 'scratchpad'
  const setScratchpadOpacity = (saved: string | null) => {
    document.documentElement.style.setProperty('--scratchpad-opacity', String(parseScratchpadOpacity(saved)))
  }
  const applyScratchpadTheme = (saved: string | null) => {
    const theme = parseScratchpadTheme(saved)
    if (theme) document.documentElement.dataset.theme = theme
  }
  const refreshScratchpadTheme = () => applyScratchpadTheme(window.localStorage.getItem(SCRATCHPAD_THEME_KEY))
  window.addEventListener('storage', (event) => {
    if (event.key === SCRATCHPAD_THEME_KEY) applyScratchpadTheme(event.newValue)
    if (event.key === SCRATCHPAD_OPACITY_KEY) setScratchpadOpacity(event.newValue)
  })
  window.addEventListener('focus', refreshScratchpadTheme)
  refreshScratchpadTheme()
  const size = Number(window.localStorage.getItem('cipherleaf-editor-font-size'))
  if (Number.isFinite(size) && size >= 10 && size <= 32) {
    document.documentElement.style.setProperty('--editor-font-size', `${size}px`)
  }
  setScratchpadOpacity(window.localStorage.getItem(SCRATCHPAD_OPACITY_KEY))
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {scratchpadWindow ? <Scratchpad overlay /> : <App />}
  </React.StrictMode>,
)
