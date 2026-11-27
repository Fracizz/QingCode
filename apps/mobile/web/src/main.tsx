import './i18n'
import { readLocalePreference } from '@qn/codex-client'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { setNativeLocale } from './native'
import './styles.css'

setNativeLocale(readLocalePreference())

const container = document.getElementById('root')
if (container) createRoot(container).render(<App />)
