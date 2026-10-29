import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import TerminalView from '../components/Terminal'
import { seedTerminalOutputFromPersist, useTerminalStore } from '../store/terminalStore'
import { useProjectStore } from '../store/projectStore'
import { useLocaleStore } from '../lib/i18n'
import '../App.css'

// Use the production terminal/store with memory-only IPC. This page requires dev:web-test,
// whose Vite config does not alias terminalStore to the project-manager stub.
async function start() {
  const id = 'terminal-interaction-fixture'
  const state = { clipboard: '', writes: [] as string[], input: [] as string[], cols: 80, rows: 24 }
  mockIPC((command, args) => {
    if (command === 'set_terminal_output_paused') return
    throw new Error(`Unexpected terminal fixture IPC: ${command} ${JSON.stringify(args)}`)
  }, { shouldMockEvents: true })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { state.clipboard = text; state.writes.push(text) },
    readText: async () => { throw new Error('Terminal must not read the clipboard via OSC') },
  } })
  useLocaleStore.getState().setLanguage('zh-CN')
  useProjectStore.setState({ projects: [], currentProject: null })
  useTerminalStore.setState({
    terminals: [{ id, name: 'fixture', projectId: 'fixture', cwd: '/fixture', launchCommand: '', status: 'running', exitCode: null }],
    writeToTerminal: async (_id, data) => { state.input.push(data) },
    resizeTerminal: async (_id, cols, rows) => { state.cols = cols; state.rows = rows },
    redrawTerminal: async () => {},
  })
  // A remounted terminal must not copy old OSC 52 actions from its output history.
  seedTerminalOutputFromPersist(id, '\x1b]52;c;b2xkLWNsaXBib2FyZA==\x07history\r\n', [])
  await useTerminalStore.getState().initializeTerminalEvents()
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
  Object.assign(window, { terminalFixture: { state, output } })
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
