import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { call } from './lib/backend'
import './styles.css'

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
