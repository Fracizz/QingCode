import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installContextMenuGuard } from './lib/contextMenuGuard'
import { installDeveloperMode } from './lib/developerMode'
import { paintStartupSplashLogo } from './lib/appIconSvg'
import { applyFontSettings, loadFontSettings } from './lib/fontSettings'
import { applyTheme, loadTheme } from './lib/themeSettings'
import { revealAppWindow } from './lib/appWindow'
import { initializeLanguage } from './lib/i18n'
import { installStartupSplashGuard } from './lib/startupSplash'

applyTheme(loadTheme())
initializeLanguage()
installContextMenuGuard()
installDeveloperMode()
paintStartupSplashLogo()
applyFontSettings(loadFontSettings())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

installStartupSplashGuard()
revealAppWindow()
