import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import type { Channel } from '@tauri-apps/api/core'
import type { UpdatePhase } from '../lib/directServerUpdate'
import SshServerStatusChip from '../components/SshServerStatusChip'
import DirectServerUpdateDialog from '../components/DirectServerUpdateDialog'
import Toaster from '../components/Toaster'
import { useUIStore, useProjectStore, useWebTestOperations, trustProject } from './projectManagerAdapters'
import { useStartupServerUpdates } from '../hooks/useStartupServerUpdates'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import type { SshServerState } from '../lib/sshServerStatus'
import '../App.css'

const rootUri = 'ssh://version-fixture/D:/code/qingcode'
const startup = new URLSearchParams(location.search).has('startup')
const fixtureProject = { id: 'startup-server', name: 'WinDev', path: rootUri, connection_id: 'version-fixture', kind: 'ssh' as const, created_at: 1, last_opened_at: 1 }
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
if (new URLSearchParams(location.search).has('ready')) state = { ...state, phase: 'readyServer', mode: 'server', version: '0.1.14-beta.14', reason: null }
let pending: (() => void) | null = null
let calls = 0
let prepareCalls = 0
let downloadCalls = 0
let failure = new URLSearchParams(location.search).has('fail')
let packageScenario = new URLSearchParams(location.search).get('package') ?? 'cached'
let finishPrepare: (() => void) | null = null

export default function Page() {
  useStartupServerUpdates(startup)
  const updateRoot = useUIStore(s => s.serverUpdateRootUri)
  const operations = useWebTestOperations(s => s.operations)
  const [view, setView] = useState('dark')
  return (
    <main className="h-full bg-bg p-5 text-fg">
      <p>Server 版本更新 Web 验收 · 内存场景，不建立 SSH 或下载真实服务包。</p>
      <label>
        模拟服务包
        <select
          aria-label="模拟服务包"
          onChange={event => {
            packageScenario = event.target.value
          }}
        >
          <option value="cached">本机缓存可用</option>
          <option value="download">需要本机下载</option>
          <option value="old">离线包版本过旧</option>
          <option value="missing">目录缺少平台文件</option>
          <option value="cancel">取消选择目录</option>
        </select>
      </label>
      <button onClick={() => finishPrepare?.()}>完成准备</button>
      <button onClick={() => useUIStore.setState({ serverUpdateRootUri: rootUri })}>打开更新弹窗</button>
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
      <output data-testid="prepare-calls">{prepareCalls}</output>
      <output data-testid="download-calls">{downloadCalls}</output>
      <output data-testid="notifications">{operations.map(operation => operation.action).join('\n')}</output>
      <SshServerStatusChip rootUri={rootUri} />
      {updateRoot && <DirectServerUpdateDialog rootUri={updateRoot} />}
      <Toaster />
    </main>
  )
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.setState({ language: 'zh-CN' })
  const recordToast = useProjectStore.getState().pushToast
  useProjectStore.setState({
    ...(startup ? { projects: [fixtureProject, { ...fixtureProject, id: 'same-server', path: `${rootUri}-other`, last_opened_at: 0 }] } : {}),
    pushToast(kind, text) {
      recordToast(kind, text)
      useProjectStore.setState(state => ({ toasts: [...state.toasts, {
        id: `completion-${state.toasts.length}`, kind: kind === 'success' ? 'success' : 'info', text,
      }] }))
    },
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
  if (startup && !new URLSearchParams(location.search).has('untrusted')) trustProject(fixtureProject)
  mockIPC(
    async (command, rawArgs) => {
      const args = rawArgs as Record<string, unknown> | undefined
      if (command === 'db_url') return 'sqlite:startup-fixture'
      if (command === 'plugin:sql|load') return 'sqlite:startup-fixture'
      if (command === 'plugin:sql|select') return useProjectStore.getState().sshConnections
      if (command === 'default_settings_path') return '/fixture/default-settings.json'
      if (command === 'read_file') return '// in-memory settings\n{"ssh.server.autoDownload":true}'
      if (command === 'ssh_workspace_status') return true
      if (command === 'ssh_prepare_workspace') {
        if (state.phase !== 'readyServer') throw new Error(state.reason ?? 'Server 版本不匹配')
        return null
      }
      if (command === 'plugin:dialog|open')
        return packageScenario === 'cancel' ? null : '/fixture/offline/servers'
      if (command === 'direct_agent_prepare_update') {
        prepareCalls += 1
        document.querySelector('[data-testid="prepare-calls"]')!.textContent = String(prepareCalls)
        const progress = args?.onProgress as Channel<UpdatePhase>
        const source = args?.packageSource as { mode: string; directory?: string; allowDownload?: boolean }
        progress.onmessage('checkingPackage')
        if (source.mode === 'automatic' && packageScenario === 'download') {
          if (source.allowDownload === false) return {
            expectedVersion: '0.1.14-beta.14', packageVersion: null,
            directory: null, sourcePath: null, problem: '未找到匹配的本机离线包',
          }
          downloadCalls += 1
          document.querySelector('[data-testid="download-calls"]')!.textContent = String(downloadCalls)
          progress.onmessage('downloading')
          await new Promise<void>(resolve => {
            finishPrepare = resolve
          })
          finishPrepare = null
        }
        const directory = source.directory ?? '/fixture/cache/servers'
        return {
          expectedVersion: '0.1.14-beta.14',
          packageVersion: packageScenario === 'old' ? '0.1.14-beta.9' : '0.1.14-beta.14',
          directory,
          sourcePath: `${directory}/qingcode-server-windows-x86_64.exe`,
          problem:
            packageScenario === 'old'
              ? '服务包版本不匹配'
              : packageScenario === 'missing'
                ? '服务目录缺少当前主机需要的文件'
                : null,
        }
      }
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
        const progress = (args?.options as { onProgress: Channel<UpdatePhase> }).onProgress
        progress.onmessage('uploading')
        calls += 1
        document.querySelector('[data-testid="update-calls"]')!.textContent = String(calls)
        await new Promise<void>(resolve => {
          pending = resolve
        })
        if (failure) {
          progress.onmessage('restoring')
          throw new Error('SSH host identity changed; update refused')
        }
        progress.onmessage('verifying')
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
