import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import TerminalExitNotice from '../components/TerminalExitNotice'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import '../App.css'

function Page() {
  const [ended, setEnded] = useState(true)
  const [code, setCode] = useState<number | null>(1)
  const [reopened, setReopened] = useState(0)
  const [exported, setExported] = useState(0)
  return (
    <main className="h-full overflow-auto bg-bg p-5 text-fg">
      <h1 className="mb-4 text-ui-lg">终端异常退出 Web 验收</h1>
      <div className="mb-4 flex flex-wrap gap-3">
        <button onClick={() => { setEnded(true); setCode(1) }}>模拟进程退出</button>
        <button onClick={() => { setEnded(true); setCode(null) }}>模拟会话丢失</button>
        <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }}>切换主题</button>
        <button onClick={async () => {
          const language = useLocaleStore.getState().language === 'en' ? 'zh-CN' : 'en'
          await ensureBuiltinLocaleLoaded(language)
          useLocaleStore.getState().setLanguage(language)
        }}>切换语言</button>
      </div>
      <div className="flex min-h-64 flex-col overflow-hidden rounded border border-border">
        <pre className="flex-1 whitespace-pre-wrap bg-bg-deep p-3">Claude 历史输出已保留{reopened > 0 ? '\nPowerShell >' : ''}</pre>
        {ended && <TerminalExitNotice exitCode={code} onReopen={async () => { setReopened(value => value + 1); setEnded(false) }} onExport={async () => { setExported(value => value + 1) }} />}
      </div>
      <output className="mt-4 block" data-testid="actions">reopened={reopened}; exported={exported}</output>
    </main>
  )
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.getState().setLanguage('zh-CN')
  createRoot(document.getElementById('root')!).render(<Page />)
}
