import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import TerminalSessionList from '../components/TerminalSessionList'
import { useLocaleStore } from '../lib/i18n'
import { markTerminalAttention } from '@/lib/terminal/terminalAttention'
import { noteTerminalProgramState } from '@/lib/terminal/terminalProgramActivity'
import type { Project, SshConnection, TerminalTab } from '../types'
import { useProjectStore, useTerminalStore, useWebTestOperations } from './projectManagerAdapters'
import '../App.css'

/**
 * 终端工作台左侧列表的 Web 验收页：真实组件与样式，项目、连接与终端都是内存数据，
 * 覆盖本机 / WSL / SSH 同名项目、运行中 / 新结果 / 空闲 / 已退出 / 待恢复各状态。
 */
const MINUTE = 60_000
const now = Date.now()

const connections = [
  { id: 'windev', name: 'WinDev', host: '192.0.2.10' },
  { id: 'ubuntu', name: 'hy-Ubuntu26', host: '192.0.2.20' },
].map(item => ({
  port: 22, username: 'dev', auth_kind: 'privateKey', host_key_fingerprint: '', created_at: now, updated_at: now, ...item,
})) as SshConnection[]

const wsl = (id: string, name: string): Project => ({
  id, name, kind: 'wsl', path: `\\\\wsl.localhost\\Ubuntu\\home\\dev\\${name}`, created_at: now, last_opened_at: now,
})
const local = (id: string, name: string): Project => ({
  id, name, kind: 'local', path: `D:\\code\\${name}`, created_at: now, last_opened_at: now,
})
const ssh = (id: string, name: string, connection: string): Project => ({
  id, name, kind: 'ssh', connection_id: connection, root_path: `/home/dev/${name}`,
  path: `ssh://${connection}/home/dev/${name}`, created_at: now, last_opened_at: now,
})

const projects = [
  wsl('django-wsl', 'django'),
  local('qingcode-local', 'QingCode'),
  wsl('nem-wsl', 'nem-panel'),
  ssh('qingcode-windev', 'qingcode', 'windev'),
  ssh('nem-windev', 'nem-panel', 'windev'),
  ssh('django-windev', 'django', 'windev'),
  ssh('eman-windev', 'EMAN-UPGRADE-APP-V2', 'windev'),
  ssh('django-ubuntu', 'django', 'ubuntu'),
  ssh('nem-ubuntu', 'nem-panel', 'ubuntu'),
  local('emis-local', 'emis-install-nempanel-pkg'),
  local('emop-local', 'AI周报助手EMOP'),
  local('work-local', 'work'),
  wsl('eman-next-wsl', 'eman-next'),
  ssh('qingcode-ubuntu', 'QingCode', 'ubuntu'),
  ssh('agent-windev', 'agent-cli', 'windev'),
].map((project, index) => ({ ...project, sort_order: index }))

const term = (id: string, name: string, projectId: string, minutesAgo: number, extra: Partial<TerminalTab> = {}): TerminalTab => ({
  id, name, projectId, cwd: '', launchCommand: '', status: 'running', exitCode: null,
  createdAt: now - (minutesAgo + 30) * MINUTE, lastActiveAt: now - minutesAgo * MINUTE, ...extra,
})

const terminals = [
  term('t-build', 'QingCode beta 本地构建', 'qingcode-local', 8),
  term('t-icon', '图标对齐问题', 'qingcode-windev', 4),
  term('t-prewarm', 'windev 预热失效问题', 'qingcode-windev', 3),
  term('t-cli', 'Nem-panel-cli Linux版本', 'nem-windev', 1),
  term('t-skill', 'commit-push 技能触发规则', 'nem-windev', 13, { status: 'exited', exitCode: 0, endedAt: now - 13 * MINUTE }),
  term('t-report', '工时与周报检查', 'emop-local', 10),
  term('t-restore', '旧会话待恢复', 'work-local', 60 * 26, { status: 'exited', awaitingRestoreSpawn: true }),
]

export default function Page() {
  const operations = useWebTestOperations(state => state.operations)
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark')
  const switchTheme = (value: string) => {
    document.documentElement.dataset.theme = value
    setTheme(value)
  }
  return (
    <main className="flex h-full bg-bg text-fg">
      <aside data-preview-list className="h-full w-[340px] flex-shrink-0 border-r border-divider">
        <TerminalSessionList />
      </aside>
      <section className="min-w-0 flex-1 p-5 text-ui-sm text-fg-muted">
        <h1 className="text-ui-lg text-fg">终端列表 Web 验收</h1>
        <p className="my-2">真实组件与样式 · 内存项目与终端 · 不启动或结束任何真实进程</p>
        <label className="flex items-center gap-2">
          主题
          <select value={theme} onChange={event => switchTheme(event.target.value)} className="bg-bg-input text-fg">
            {['dark', 'ink', 'light', 'olive'].map(value => <option key={value}>{value}</option>)}
          </select>
        </label>
        <pre data-testid="operation-log" className="mt-4">{JSON.stringify(operations, null, 2)}</pre>
      </section>
    </main>
  )
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.setState({ language: 'zh-CN' })
  useProjectStore.setState({
    projects,
    sshConnections: connections,
    currentProject: projects.find(project => project.id === 'qingcode-windev') ?? null,
  })
  useTerminalStore.setState({ terminals, activeTerminalId: 't-prewarm' })
  // 运行中按 OSC 7501 上报模拟；后台任务结束待查看的新结果直接标记。
  noteTerminalProgramState('t-cli', 'working')
  markTerminalAttention('t-report')
  createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>)
}
