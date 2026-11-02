import { createRoot, type Root } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import RemoteConnectionsManager from '../components/RemoteConnectionsManager'
import ConfirmDialog from '../components/ConfirmDialog'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import { useProjectStore, useUIStore, useWebTestOperations } from './projectManagerAdapters'
import { projectManagerFixtures } from './projectManagerFixtures'
import type { SshServerState } from '../lib/sshServerStatus'
import '../App.css'

export default function Page() {
  const open = useUIStore(s => s.remoteConnectionsOpen)
  const operations = useWebTestOperations(s => s.operations)
  const button = 'rounded border border-border-strong px-3 py-2 text-ui hover:bg-bg-hover'
  return <>
    <main className="h-full bg-bg p-4 text-fg">
      <h1>远程连接概览 Web 测试 · 固定内存数据</h1>
      <div className="my-4 flex flex-wrap gap-3">
        <button className={button} onClick={() => useUIStore.setState({ remoteConnectionsOpen: true })}>打开远程连接</button>
        <button className={button} onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }}>切换主题</button>
        <button className={button} onClick={async () => { await ensureBuiltinLocaleLoaded('en'); useLocaleStore.getState().setLanguage(useLocaleStore.getState().language === 'en' ? 'zh-CN' : 'en') }}>切换语言</button>
      </div>
      <pre data-testid="operation-log">{JSON.stringify(operations)}</pre>
    </main>
    {open && <RemoteConnectionsManager />}
    <ConfirmDialog />
  </>
}

if (import.meta.env.DEV && import.meta.env.MODE === 'web-test') {
  const fixture = projectManagerFixtures()
  const connections = fixture.sshConnections.map(connection => ({ ...connection, mode: 'server' as const }))
  useProjectStore.setState({
    sshConnections: [...connections, { ...connections[0], id: 'fixture-tls', name: 'Build Server', host: 'build.example.test', username: 'Agent', auth_kind: 'password', host_key_fingerprint: 'fixture-tls', agentEndpoint: { host: 'build.example.test', port: 48763 } }],
    projects: [...fixture.projects, ...Array.from({ length: 6 }, (_, index) => ({ id: `extra-${index}`, name: `service-${index}`, path: `ssh://fixture-wsl/home/code/service-${index}`, kind: 'ssh' as const, hidden: 1, created_at: 1, last_opened_at: index }))],
  })
  mockIPC((command, args) => {
    const params = args as Record<string, unknown> | undefined
    const id = String(params?.connectionId ?? '')
    if (command === 'ssh_connection_status') return id !== 'fixture-windev'
    if (command === 'ssh_workspace_roots') return id === 'fixture-wsl' ? [{ rootUri: 'ssh://fixture-wsl/home/code/nem-panel', trusted: true }] : []
    if (command === 'ssh_server_states') {
      if (id === 'fixture-windev') throw new Error('Fixture: authentication required; open a project to reconnect.')
      return [{ connectionId: id, rootUri: `ssh://${id}/home/code/nem-panel`, phase: 'readyServer', mode: 'server', connectionMode: 'server', version: 'fixture', transport: id === 'fixture-tls' ? 'agent' : 'daemon', reason: null } satisfies SshServerState]
    }
    if (command === 'direct_agent_info') return id === 'fixture-tls' ? { enabled: true, host: 'build.example.test', port: 48763, certificateFingerprint: 'fixture-tls', tokenSaved: true, previousPorts: [] } : null
    if (command === 'ssh_server_logs') return { text: '[fixture] remote service ready\n[fixture] no real SSH connection was created' }
    throw new Error(`Unexpected overview fixture command: ${command}`)
  }, { shouldMockEvents: true })
  useLocaleStore.getState().setLanguage('zh-CN')
  const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!)
  if (import.meta.hot) import.meta.hot.data.root = root
  root.render(<Page />)
}
