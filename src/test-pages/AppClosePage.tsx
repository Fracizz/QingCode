import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChoiceDialog from '../components/ChoiceDialog'
import { choiceDialog } from '../store/choiceStore'
import { runAppClose } from '../lib/appCloseFlow'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import type { TerminalTab } from '../types'
import '../App.css'

function remote(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { id, name: id, projectId: id, cwd: `ssh://fixture/${id}`, launchCommand: '',
    status: 'running', exitCode: null, persistent: true, ptyId: `pty-${id}`, connectionId: 'fixture', ...overrides }
}

export function AppClosePage() {
  const tabs = useRef<TerminalTab[]>([])
  const [events, setEvents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [cancelSave, setCancelSave] = useState(false)
  const record = (event: string) => setEvents(items => [...items, event])
  const open = async (scenario: 'mixed' | 'offline' | 'local') => {
    setBusy(true)
    setEvents([])
    tabs.current = scenario === 'local'
      ? [remote('local', { cwd: '/tmp/app-close', persistent: false, ptyId: undefined })]
      : [remote('SSH'), remote('Server', { status: 'exited', awaitingRestoreSpawn: true }),
        remote('compat', { persistent: false, ptyId: undefined }),
        remote('local', { cwd: '/tmp/app-close', persistent: false, ptyId: undefined })]
    let fail = scenario === 'offline'
    try {
      await runAppClose({
        pauseSpawns: async () => { record('pause') }, resumeSpawns: () => record('resume'),
        terminals: () => tabs.current, transferCount: () => scenario === 'mixed' ? 2 : 0,
        choose: choiceDialog, confirmFiles: async () => { record('files'); return !cancelSave },
        finishRemote: async (tab, action) => {
          if (fail && tab.id === 'SSH' && action === 'terminate') {
            fail = false
            record('unconfirmed:SSH')
            throw new Error('远端未确认结束终端')
          }
          record(`${action}:${tab.id}`)
        },
        closeTerminal: async tab => { record(`close:${tab.id}`) },
        markEnded: tab => { tab.endedAt = Date.now(); tab.status = 'exited'; record(`ended:${tab.id}`) },
        markDetached: tab => { record(`detached:${tab.id}`) },
        flush: () => record('flush'), destroy: async () => { record('destroy') },
      })
    } finally { setBusy(false) }
  }
  return <main className="h-full overflow-auto bg-bg p-5 text-fg">
    <h1 className="mb-4 text-ui-lg">退出 QingCode Web 验收</h1>
    <p className="mb-4 text-fg-muted">使用真实退出决策和共享弹窗；文件保存、PTY 与窗口接口为内存模拟。</p>
    <div className="flex flex-wrap gap-4">
      <button disabled={busy} onClick={() => void open('mixed')}>混合终端退出</button>
      <button disabled={busy} onClick={() => void open('offline')}>模拟远端未确认</button>
      <button disabled={busy} onClick={() => void open('local')}>仅本地终端退出</button>
      <label><input type="checkbox" checked={cancelSave} disabled={busy} onChange={event => setCancelSave(event.target.checked)} />取消文件保存确认</label>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }}>切换主题</button>
      <button onClick={async () => {
        const language = useLocaleStore.getState().language === 'en' ? 'zh-CN' : 'en'
        await ensureBuiltinLocaleLoaded(language)
        useLocaleStore.getState().setLanguage(language)
      }}>切换语言</button>
    </div>
    <output data-testid="exit-events" className="mt-4 block whitespace-pre-wrap">{events.join('\n')}</output>
    <ChoiceDialog />
  </main>
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.getState().setLanguage('zh-CN')
  createRoot(document.getElementById('root')!).render(<AppClosePage />)
}
