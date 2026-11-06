import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import TerminalManager from '../components/TerminalManager'
import ConfirmDialog from '../components/ConfirmDialog'
import PromptDialog from '../components/PromptDialog'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import {
  resetTerminalManagerFixture,
  useTerminalManagerFixture,
  useTerminalStore,
  useUIStore,
  useWebTestOperations,
} from './projectManagerAdapters'
import '../App.css'

export default function Page() {
  const open = useUIStore(state => state.terminalManagerOpen)
  const terminals = useTerminalStore(state => state.terminals)
  const operations = useWebTestOperations(state => state.operations)
  return (
    <>
      <main className="h-full bg-bg p-5 text-fg">
        <h1 className="text-ui-lg">终端管理 Web 验收</h1>
        <p className="my-3 text-ui-sm text-fg-muted">真实组件与样式 · 65 个内存终端 · 不启动或结束任何真实进程</p>
        <button onClick={() => resetTerminalManagerFixture()}>重置终端</button>
        <button className="ml-4" onClick={() => useUIStore.getState().openTerminalManager()}>打开终端管理</button>
        <output data-testid="remaining" className="mt-4 block">{terminals.length}</output>
        <pre data-testid="operation-log">{JSON.stringify(operations, null, 2)}</pre>
      </main>
      {open && <TerminalManager />}
      <ConfirmDialog />
      <PromptDialog />
    </>
  )
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.setState({ language: 'zh-CN' })
  resetTerminalManagerFixture()
  Object.assign(window, {
    __terminalManagerFixture: {
      reset: resetTerminalManagerFixture,
      fail: (ids: string[]) => useTerminalManagerFixture.setState({ failedIds: ids }),
      terminals: () => useTerminalStore.getState().terminals,
      operations: () => useWebTestOperations.getState().operations,
      locale: async (language: string) => {
        await ensureBuiltinLocaleLoaded(language)
        useLocaleStore.setState({ language })
      },
    },
  })
  createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>)
}
