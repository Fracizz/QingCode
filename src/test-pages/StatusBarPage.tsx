import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import StatusBar from '../components/StatusBar'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { projectManagerFixtures } from './projectManagerFixtures'
import { interfaceMetrics } from '../lib/interfaceMetrics'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import type { SshServerState } from '../lib/sshServerStatus'
import '../App.css'

const fixtures = projectManagerFixtures()
const project = fixtures.projects.find(item => item.id === 'win-nem')!
let serverState: SshServerState = {
  connectionId: 'fixture-windev', rootUri: project.path,
  phase: 'readyServer', mode: 'server', connectionMode: 'server',
  version: 'fixture', transport: 'agent', reason: null,
}

export function StatusBarPage() {
  const [theme, setTheme] = useState('dark')
  const [fontSize, setFontSize] = useState(13)
  const [phase, setPhase] = useState('readyServer')
  const view = useUIStore(state => state.view)
  const terminalSignal = useUIStore(state => state.terminalToggleSignal)
  return (
    <main className="flex h-full flex-col bg-bg text-fg">
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <h1 className="text-ui-lg font-semibold">底栏 Web 验收</h1>
        <label>主题 <select aria-label="测试主题" className="setting-control" value={theme} onChange={event => {
          setTheme(event.target.value)
          document.documentElement.dataset.theme = event.target.value
        }}>
          <option value="dark">深色</option><option value="light">浅色</option><option value="olive">橄榄绿</option>
        </select></label>
        <label>字号 <select aria-label="测试字号" className="setting-control" value={fontSize} onChange={event => {
          const metrics = interfaceMetrics(Number(event.target.value))
          setFontSize(metrics.fontSize)
          for (const [key, value] of Object.entries({
            '--ui-font-size': metrics.fontSize, '--ui-font-size-sm': metrics.smallFontSize,
            '--ui-line-height': metrics.lineHeight, '--status-bar-height': metrics.statusHeight,
          })) document.documentElement.style.setProperty(key, `${value}px`)
        }}>
          <option value="13">13px</option><option value="20">20px</option><option value="32">32px</option>
        </select></label>
        <label>连接 <select aria-label="测试连接状态" className="setting-control" value={phase} onChange={event => {
          const value = event.target.value as SshServerState['phase']
          setPhase(value)
          serverState = { ...serverState, phase: value, reason: value === 'disconnected' ? 'Fixture connection timed out' : null }
          void emit('ssh-server-state', serverState)
        }}>
          <option value="readyServer">服务就绪</option><option value="authenticating">认证中</option>
          <option value="handshaking">连接中</option><option value="disconnected">已断开</option>
        </select></label>
        <label>语言 <select aria-label="测试语言" className="setting-control" defaultValue="zh-CN" onChange={async event => {
          const language = event.target.value
          await ensureBuiltinLocaleLoaded(language)
          useLocaleStore.setState({ language })
        }}><option value="zh-CN">中文</option><option value="en">English</option></select></label>
        <label><input type="checkbox" aria-label="测试长名称" onChange={event => {
          const name = event.target.checked ? 'nem-panel-production-workspace-with-long-name' : project.name
          const currentProject = { ...project, name }
          useProjectStore.setState({
            currentProject,
            projects: fixtures.projects.map(item => item.name === project.name ? { ...item, name } : item),
          })
          useGitStatusStore.getState().setPanelStatus(project.path, {
            is_repository: true, branch: event.target.checked ? 'feature/status-bar-readability-with-long-branch-name' : 'test', changes: [],
          })
        }} /> 长项目与分支名称</label>
      </div>
      <p className="p-4 text-ui-sm text-fg-muted">
        真实底栏与业务 Store，固定内存数据；不建立 SSH、不读写真实文件。浏览器不模拟原生桌面身份，内存和版本不会加载。
      </p>
      <output className="px-4 text-ui-sm" data-testid="actions">{view} · terminal:{terminalSignal}</output>
      <div className="min-h-0 flex-1" />
      <div className="border-t border-border bg-bg-deep p-4 font-mono text-ui-sm text-fg-muted">
        PS D:\code\nem-panel&gt; <span className="text-fg">pnpm dev</span>
      </div>
      <StatusBar />
    </main>
  )
}

if (import.meta.env.DEV && import.meta.env.MODE === 'web-test') {
  // Use dev:web-test (38419); test:web aliases the stores to project-manager stubs.
  mockIPC(command => {
    if (command === 'ssh_server_info') return serverState
    if (command === 'ssh_server_logs') return { text: 'Fixture service ready' }
    throw new Error(`Unexpected status-bar fixture IPC: ${command}`)
  }, { shouldMockEvents: true })
  useLocaleStore.setState({ language: 'zh-CN' })
  useProjectStore.setState({ ...fixtures, currentProject: project })
  useEditorStore.setState({
    tabs: [{ id: 'fixture-file', name: 'index.ts', path: `${project.path}/src/index.ts`, content: '', dirty: false, encoding: 'utf8' }],
    activeTabId: 'fixture-file', cursor: { line: 1, col: 1 },
  })
  useTerminalStore.setState({ terminals: [], activeTerminalId: null })
  useGitStatusStore.getState().setPanelStatus(project.path, { is_repository: true, branch: 'test', changes: [] })
  createRoot(document.getElementById('root')!).render(<StatusBarPage />)
} else document.getElementById('root')!.textContent = '请运行 pnpm dev:web-test。'
