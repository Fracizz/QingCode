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
initializeLanguage()
paintStartupSplashLogo()
applyFontSettings(loadFontSettings())

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
