import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import SshServerStatusChip from '../components/SshServerStatusChip'
import DirectServerUpdateDialog from '../components/DirectServerUpdateDialog'
import { useUIStore, useProjectStore } from './projectManagerAdapters'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import type { SshServerState } from '../lib/sshServerStatus'
import '../App.css'

const rootUri = 'ssh://version-fixture/D:/code/qingcode'
let state: SshServerState = {
  rootUri,
  connectionId: 'version-fixture',
  phase: 'probing',
  mode: 'unknown',
  connectionMode: 'server',
  transport: 'agent',
  version: null,
  reason: 'daemon 版本不匹配：远端 0.1.14-beta.9，本端 0.1.14-beta.12',
}
let pending: (() => void) | null = null
let calls = 0
let failure = false

export default function Page() {
  const updateRoot = useUIStore(s => s.serverUpdateRootUri)
  const [view, setView] = useState('dark')
  return (
    <main className="h-full bg-bg p-5 text-fg">
      <p>Server 版本更新 Web 验收 · 内存场景</p>
      <button
        onClick={() => {
          pending?.()
          pending = null
        }}
      >
        完成更新
      </button>
      <button
        onClick={() => {
          failure = !failure
        }}
      >
        切换更新失败
      </button>
      <button
        onClick={async () => {
          const next = view === 'dark' ? 'light' : 'dark'
          setView(next)
          document.documentElement.dataset.theme = next
          await ensureBuiltinLocaleLoaded('en')
          useLocaleStore.setState({ language: next === 'light' ? 'en' : 'zh-CN' })
        }}
      >
        切换语言主题
      </button>
      <output data-testid="update-calls">{calls}</output>
      <SshServerStatusChip rootUri={rootUri} />
      {updateRoot && <DirectServerUpdateDialog rootUri={updateRoot} />}
    </main>
  )
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.setState({ language: 'zh-CN' })
  useProjectStore.setState({
    sshConnections: [
      {
        id: 'version-fixture',
        name: 'WinDev',
        host: '192.168.252.107',
        port: 28822,
        username: 'Administrator',
        auth_kind: 'privateKey',
        private_key_path: '/fixture/id_ed25519',
        host_key_fingerprint: 'SHA256:fixture',
        agentEndpoint: { host: '192.168.252.107', port: 48763 },
        created_at: 1,
        updated_at: 1,
      },
    ],
  })
  mockIPC(
    async command => {
      if (command === 'ssh_server_info') return state
      if (command === 'direct_agent_info')
        return {
          enabled: true,
          host: '192.168.252.107',
          port: 48763,
          certificateFingerprint: 'a'.repeat(64),
          tokenSaved: true,
          previousPorts: [],
        }
      if (command === 'direct_agent_update') {
        calls += 1
        document.querySelector('[data-testid="update-calls"]')!.textContent = String(calls)
        await new Promise<void>(resolve => {
          pending = resolve
        })
        if (failure) throw new Error('SSH host identity changed; update refused')
        state = {
          ...state,
          phase: 'readyServer',
          mode: 'server',
          version: '0.1.14-beta.12',
          reason: null,
        }
        await emit('ssh-server-state', state)
        return state
      }
      throw new Error(`Unexpected command: ${command}`)
    },
    { shouldMockEvents: true }
  )
  createRoot(document.getElementById('root')!).render(<Page />)
}
