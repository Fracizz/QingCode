import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installContextMenuGuard } from './lib/contextMenuGuard'
import { paintStartupSplashLogo } from './lib/appIconSvg'
import { applyFontSettings, loadFontSettings } from './lib/fontSettings'
import { applyTheme, loadTheme } from './lib/themeSettings'
import { revealAppWindow } from './lib/appWindow'

applyTheme(loadTheme())
installContextMenuGuard()
paintStartupSplashLogo()
applyFontSettings(loadFontSettings())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

revealAppWindow()
