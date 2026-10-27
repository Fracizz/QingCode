import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import ProjectName from '../components/ProjectName'
import SshImportDialog from '../components/SshImportDialog'
import SshServerStatusChip from '../components/SshServerStatusChip'
import { SettingItem } from '../components/SettingsLayout'
import { ensureBuiltinLocaleLoaded, useI18n, useLocaleStore } from '../lib/i18n'
import { interfaceMetrics } from '../lib/interfaceMetrics'
import type { SshServerState } from '../lib/sshServerStatus'
import type { SshImportCandidate } from '../lib/sshConfigImport'
import '../App.css'

const initialState: SshServerState = {
  connectionId: 'fixture',
  rootUri: 'ssh://fixture/home/demo/project',
  phase: 'readyServer',
  mode: 'server',
  connectionMode: 'server',
  version: '0.1.14',
  transport: 'daemon',
  reason: null,
}
let serverState = initialState
const candidates: SshImportCandidate[] = [
  {
    name: 'Development',
    host: 'dev.example.test',
    username: 'developer',
    port: 22,
    authKind: 'privateKey',
    privateKeyPath: '/home/demo/.ssh/development/id_ed25519',
    issue: null,
  },
  {
    name: 'Staging',
    host: 'staging.example.test',
    username: 'deploy',
    port: 2222,
    authKind: 'privateKey',
    privateKeyPath: '/home/demo/.ssh/staging/id_ed25519',
    issue: null,
  },
  {
    name: 'Very-long-production-connection-name-for-readability',
    host: 'production.example.test',
    username: 'operator',
    port: 22,
    authKind: 'password',
    privateKeyPath: '',
    issue: null,
  },
]

export default function UiClarityPage() {
  const { t } = useI18n()
  const [importOpen, setImportOpen] = useState(false)
  const [theme, setTheme] = useState('dark')
  const [fontSize, setFontSize] = useState(13)
  const [scenario, setScenario] = useState('readyServer')
  const language = useLocaleStore(state => state.language)
  const buttonClass = 'rounded border border-border-strong px-3 py-1.5 text-ui hover:bg-bg-hover'
  return (
    <main className="h-full overflow-auto bg-bg p-5 text-fg">
      <h1 className="text-ui-lg font-semibold">界面清晰度 Web 测试</h1>
      <p className="mt-2 text-ui-sm text-fg-muted">
        真实组件与样式 · 固定内存数据 · 不连接主机或写入磁盘
      </p>
      <div className="my-5 flex flex-wrap items-center gap-3">
        <label>
          主题{' '}
          <select
            className="setting-control"
            aria-label="测试主题"
            value={theme}
            onChange={event => {
              setTheme(event.target.value)
              document.documentElement.dataset.theme = event.target.value
            }}
          >
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="olive">橄榄绿</option>
          </select>
        </label>
        <label>
          语言{' '}
          <select
            className="setting-control"
            aria-label="测试语言"
            value={language}
            onChange={async event => {
              const value = event.target.value
              await ensureBuiltinLocaleLoaded(value)
              useLocaleStore.setState({ language: value })
            }}
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          界面字号{' '}
          <select
            className="setting-control"
            aria-label="测试字号"
            value={fontSize}
            onChange={event => {
              const metrics = interfaceMetrics(Number(event.target.value))
              setFontSize(metrics.fontSize)
              for (const [property, value] of Object.entries({
                '--ui-font-size': metrics.fontSize,
                '--ui-font-size-sm': metrics.smallFontSize,
                '--ui-line-height': metrics.lineHeight,
                '--ui-control-height': metrics.controlHeight,
                '--ui-chip-height': metrics.chipHeight,
                '--status-bar-height': metrics.statusHeight,
              }))
                document.documentElement.style.setProperty(property, `${value}px`)
            }}
          >
            <option value="13">13px</option>
            <option value="16">16px</option>
            <option value="20">20px</option>
          </select>
        </label>
      </div>

      <div className="max-w-3xl space-y-6">
        <div
          className="flex max-w-sm items-center gap-2 rounded border border-border-strong p-3"
          data-testid="project-label"
        >
          <ProjectName
            name="nem-panel"
            label={{ name: 'nem-panel', source: 'WinDev', text: 'nem-panel [WinDev]' }}
          />
        </div>
        <div className="settings-shell rounded border border-border-strong p-4">
          <SettingItem
            title={t('项目目录')}
            description={t('从顶栏隐藏后，项目仍保留在列表中。移除项目不会删除磁盘文件。')}
          >
            <input
              aria-label={t('项目目录')}
              className="setting-input w-full px-2 py-1"
              defaultValue="/home/demo/projects/nem-panel"
            />
          </SettingItem>
          <div className="mt-5">
            <SettingItem
              title={t('服务安装设置')}
              description={t('准备完成后会自动更新状态，无需重复操作。')}
              locked
              lockHint={t('请先信任该工作区，再切换到远端服务')}
            >
              <select aria-label={t('连接模式')} disabled className="setting-control">
                <option>{t('SSH + 远端服务')}</option>
              </select>
            </SettingItem>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="测试连接状态"
            className="setting-control"
            value={scenario}
            onChange={event => {
              const value = event.target.value
              setScenario(value)
              serverState = {
                ...initialState,
                phase:
                  value === 'compatibility' ? 'readyDirect' : (value as SshServerState['phase']),
                connectionMode: value === 'compatibility' ? 'ssh' : 'server',
                mode:
                  value === 'compatibility'
                    ? 'direct'
                    : value === 'readyServer'
                      ? 'server'
                      : 'unknown',
                reason: value === 'disconnected' ? 'Connection timed out' : null,
              }
              void emit('ssh-server-state', serverState)
            }}
          >
            <option value="readyServer">服务就绪</option>
            <option value="authenticating">认证中</option>
            <option value="installing">安装中</option>
            <option value="handshaking">连接服务中</option>
            <option value="compatibility">兼容模式</option>
            <option value="disconnected">连接已断开</option>
          </select>
          <div className="inline-flex items-center rounded bg-bg-deep p-2" data-testid="ssh-status">
            <SshServerStatusChip rootUri={initialState.rootUri} />
          </div>
          <button className={buttonClass} onClick={() => setImportOpen(true)}>
            {t('导入已有连接')}
          </button>
        </div>
      </div>
      {importOpen && <SshImportDialog onClose={() => setImportOpen(false)} onImported={() => {}} />}
    </main>
  )
}

const root = document.getElementById('root')!
if (import.meta.env.DEV && import.meta.env.MODE === 'web-test') {
  useLocaleStore.setState({ language: 'zh-CN' })
  // Only this test entry installs IPC mocks. Unexpected native operations fail closed.
  mockIPC(
    command => {
      if (command === 'ssh_import_candidates') return { path: '/home/demo/.ssh/config', candidates }
      if (command === 'ssh_server_info') return serverState
      if (command === 'ssh_server_logs') return { text: 'Remote service ready\n文件监听已启动' }
      throw new Error(`Unexpected test command: ${command}`)
    },
    { shouldMockEvents: true }
  )
  createRoot(root).render(<UiClarityPage />)
} else root.textContent = '请运行 pnpm test:web，使用独立的 Web 测试服务。'
