import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { paintStartupSplashLogo } from './lib/appIconSvg'
import { applyFontSettings, loadFontSettings } from './lib/fontSettings'
import { applyTheme, loadTheme } from './lib/themeSettings'
import { revealAppWindow } from './lib/appWindow'
import { initializeLanguage } from './lib/i18n'
import { installStartupSplashGuard } from './lib/startupSplash'
import { initWindowSession } from './lib/windowSession'
import {
  hydrateWorkspaceSessionsIfNeeded,
  installWorkspaceSessionPersistence,
} from './lib/workspaceSessionSync'

// Critical path before first paint: theme, fonts, splash logo, i18n.
initWindowSession()
// Restore editor tabs / terminal metadata before stores paint workspace UI.
hydrateWorkspaceSessionsIfNeeded()
installWorkspaceSessionPersistence()
applyTheme(loadTheme())
void initializeLanguage()
paintStartupSplashLogo()
applyFontSettings(loadFontSettings())
// Apply global terminal settings ASAP (project overlay loads later).
void import('./lib/terminalScrollbackSettings').then(m => m.loadEffectiveTerminalScrollback(null))
void import('./lib/terminalCursorSettings').then(m =>
  m.loadEffectiveTerminalCursorBlinking(null),
)
void import('./lib/formatOnSaveSettings').then(m => m.loadEffectiveFormatOnSave(null))
void import('./lib/minimapSettings').then(m => m.loadEffectiveMinimapEnabled(null))
// Sync session-persist cache from default-settings.json for the next boot.
void import('./lib/sessionPersistSettings').then(m => m.loadSessionPersistEnabled())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

installStartupSplashGuard()

// Non-critical guards after first paint; keep splash reveal ownership in index.html.
queueMicrotask(() => {
  void import('./lib/contextMenuGuard').then(m => m.installContextMenuGuard())
  void import('./lib/developerMode').then(m => m.installDeveloperMode())
})

// Fallback only — HTML splash script should already have shown the window.
window.setTimeout(() => revealAppWindow(), 120)

// WebView2 can finish navigation with an empty #root after a decorations/size
// repair aborted the first document load. Reload once per session.
window.setTimeout(() => {
  const root = document.getElementById('root')
  if (!root || root.childElementCount > 0) return
  try {
    if (sessionStorage.getItem('qingcode:empty-root-reloaded') === '1') return
    sessionStorage.setItem('qingcode:empty-root-reloaded', '1')
  } catch {
    return
  }
  window.location.reload()
}, 800)
