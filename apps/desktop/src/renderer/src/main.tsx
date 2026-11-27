import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { call } from './lib/backend'
import { applyTheme, readCachedTheme } from './lib/theme'
import './styles.css'

// 首帧前先套上次的主题，设置读回后再以落盘值为准。
applyTheme(readCachedTheme())

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

// --smoke：渲染进程经 backend 成功调用一次 targets.list 即通知 main 退出。
if (window.qn?.isSmoke) {
  void call('targets.list')
    .then(() => window.qn.smokeDone())
    .catch((err: unknown) => console.error('[smoke] targets.list 失败', err))
}
