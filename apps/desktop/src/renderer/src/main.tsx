import './i18n'
import { getLocale, t } from '@qn/codex-client'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RenderBoundary } from './components/RenderBoundary'
import { call } from './lib/backend'
import { watchLongTasks } from './lib/longTasks'
import { dismissSplash, localizeSplash } from './lib/splash'
import { applyTheme, readCachedTheme } from './lib/theme'
import './styles.css'

// 首帧前先套上次的主题，设置读回后再以落盘值为准。
applyTheme(readCachedTheme())
localizeSplash()
window.qn?.setLocale?.(getLocale())
watchLongTasks()

function RenderFailure() {
  useEffect(() => {
    void dismissSplash()
  }, [])

  return (
    <main className="grid h-screen place-items-center bg-qn-bg px-6 text-qn-text">
      <div className="space-y-3 text-center">
        <p role="alert" className="text-ui-md">{t('桌面界面显示异常')}</p>
        <button type="button" className="qn-button-subtle" onClick={() => window.location.reload()}>{t('重新加载界面')}</button>
      </div>
    </main>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container, {
    onCaughtError: (_, { componentStack }) => {
      // 只记录组件栈，异常文本可能包含对话或凭据。
      // i18n-ignore: 仅进日志
      console.error('[renderer] 界面渲染异常', componentStack)
    },
  }).render(
    <StrictMode>
      <RenderBoundary fallback={<RenderFailure />}>
        <App />
      </RenderBoundary>
    </StrictMode>
  )
}

// --smoke：渲染进程经 backend 成功调用一次 targets.list 即通知 main 退出。
if (window.qn?.isSmoke) {
  void call('targets.list')
    .then(() => window.qn.smokeDone())
    // i18n-ignore: 仅进日志
    .catch((err: unknown) => console.error('[smoke] targets.list 失败', err))
}
