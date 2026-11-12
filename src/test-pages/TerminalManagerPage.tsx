import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
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
  if (new URLSearchParams(location.search).has('mobile-preview')) {
    const session = {
      id: 'mobile-preview', number: 49, name: '重新发布 0.03', deviceName: 'OPPO PLJ110',
      project: { id: 'wsl-nem', name: 'NEM', path: '/srv/nem', kind: 'wsl', host: 'Windows' },
    }
    const rows = Array<string>(30).fill('')
    rows[0] = '发布检查'
    rows[2] = '  | 检查项目 | 结果 |'
    rows[3] = '  | 工具版本 | 通过 |'
    rows[4] = '  | 依赖清单 | 通过 |'
    rows[6] = '正在检查当前项目的发布配置以及依赖版本信息'
    rows[7] = '，完成后将生成发布记录。'
    rows[29] = '就绪'
    Object.assign(window, { isTauri: true })
    mockIPC(command => {
      if (command === 'mobile_sessions') return [session]
      if (command === 'mobile_session_preview') {
        return { screen: rows.join('\n'), alternate: true, cols: 42, rows: 30, history: [] }
      }
      return null
    }, { shouldMockEvents: true })
  }
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
