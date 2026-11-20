import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import TerminalView from '../components/Terminal'
import { openMobileSessionTab, seedTerminalOutputFromPersist, useTerminalStore } from '../store/terminalStore'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useConfirmStore } from '../store/confirmStore'
import { useLocaleStore } from '../lib/i18n'
import { applyTerminalControlPayload, type TerminalControlPayload } from '../store/terminalControlStore'
import { mobileTerminalHistoryFixture } from './mobileTerminalHistoryFixture'
import '../App.css'

// Use the production terminal/store with memory-only IPC. This page requires dev:web-test,
// whose Vite config does not alias terminalStore to the project-manager stub.
async function start() {
  const mobileHistory = new URLSearchParams(location.search).has('mobile-history')
  const id = mobileHistory ? 'mobile-history-fixture' : 'terminal-interaction-fixture'
  const history = mobileTerminalHistoryFixture()
  const sizes: { cols: number; rows: number }[] = []
  const state = {
    clipboard: '', writes: [] as string[], input: [] as string[], cols: 80, rows: 24,
    opened: [] as Array<{ path: string; line?: number; column?: number }>,
    urls: [] as string[],
  }
  const files = new Set(['/fixture/src/a.ts'])
  mockIPC((command, args) => {
    if (command === 'set_terminal_output_paused') return
    if (mobileHistory) {
      if (command === 'mobile_session_preview' || command === 'mobile_view_open') return history.preview()
      if (command === 'mobile_session_history') return history.read((args as { before: number }).before)
      if (command === 'mobile_view_resize') {
        const { cols, rows } = args as { cols: number; rows: number }
        sizes.push({ cols, rows })
        Object.assign(state, { cols, rows })
        return
      }
    }
    if (command === 'file_stat') {
      const { path } = args as { path: string }
      if (!files.has(path)) throw new Error(`missing: ${path}`)
      return { size: 1, is_dir: false }
    }
    if (command === 'plugin:opener|open_url') {
      state.urls.push((args as { url: string }).url)
      return
    }
    throw new Error(`Unexpected terminal fixture IPC: ${command} ${JSON.stringify(args)}`)
  }, { shouldMockEvents: true })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { state.clipboard = text; state.writes.push(text) },
    readText: async () => { throw new Error('Terminal must not read the clipboard via OSC') },
  } })
  useLocaleStore.getState().setLanguage('zh-CN')
  useProjectStore.setState({ projects: [], currentProject: null })
  useEditorStore.setState({
    openFile: async (path, line, column) => { state.opened.push({ path, line, column }) },
  })
  useTerminalStore.setState({
    terminals: mobileHistory ? [] : [{ id, name: 'fixture', projectId: 'fixture', cwd: '/fixture', launchCommand: '', status: 'running', exitCode: null }],
    writeToTerminal: async (_id, data) => { state.input.push(data) },
    ...(mobileHistory ? {} : { resizeTerminal: async (_id: string, cols: number, rows: number) => { state.cols = cols; state.rows = rows } }),
    redrawTerminal: async () => false,
  })
  // A remounted terminal must not copy old OSC 52 actions from its output history.
  seedTerminalOutputFromPersist(id, '\x1b]52;c;b2xkLWNsaXBib2FyZA==\x07history\r\n', [])
  await useTerminalStore.getState().initializeTerminalEvents()
  if (mobileHistory) {
    await openMobileSessionTab({ id, name: 'fixture', project: { id: 'fixture', path: '/fixture' } })
    await emit('terminal-screen', { id, data: '\x1b[2J\x1b[HLIVE READY', cols: 42, rows: 30 })
  }
  let sequence = 0
  const output = async (data: string) => {
    const title = `parsed-fixture-${++sequence}`
    await emit('terminal-data', { id, data: Array.from(new TextEncoder().encode(`${data}\x1b]2;${title}\x07`)) })
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { unsubscribe(); reject(new Error('Terminal parser did not reach marker')) }, 4000)
      const unsubscribe = useTerminalStore.subscribe(s => {
        if (s.terminals[0]?.name !== title) return
        window.clearTimeout(timer)
        unsubscribe()
        resolve()
      })
    })
  }
  Object.assign(window, { terminalFixture: {
    state,
    output,
    historyRequests: history.requests,
    sizes,
    toasts: () => useProjectStore.getState().toasts.map(toast => toast.text),
    confirmPending: () => useConfirmStore.getState().request?.detail ?? null,
    answerConfirm: (value: boolean) => useConfirmStore.getState().answer(value),
    // 模拟多端共享：其他设备成为尺寸方时电脑跟随对方网格（payload 同 Rust terminal-control 事件）。
    control: (payload: Omit<TerminalControlPayload, 'id'>) => applyTerminalControlPayload({ id, ...payload }),
  } })
  createRoot(document.getElementById('root')!).render(
    <main className="flex h-full flex-col bg-bg text-fg">
      <p className="p-3">OpenCode / Claude 终端交互验收（内存传输）</p>
      <div className="min-h-0 flex-1"><TerminalView terminalId={id} isActive /></div>
    </main>
  )
}

if (import.meta.env.DEV && import.meta.env.MODE === 'web-test') {
  void start().catch(error => { document.getElementById('root')!.textContent = String(error) })
}
