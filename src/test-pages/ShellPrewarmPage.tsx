import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import TerminalSettingsSection from '../components/settings/TerminalSettingsSection'
import { useTerminalIntegrationSettings } from '../components/settings/useSettingsSectionState'
import ConfirmDialog from '../components/ConfirmDialog'
import { DEFAULT_FONT_SETTINGS } from '../lib/fontSettings'
import { loadTerminalProfileSettings } from '../lib/terminal/terminalProfiles'
import { useLocaleStore } from '../lib/i18n'
import { trustProject } from '../lib/workspaceTrust'
import type { Project } from '../types'
import '../App.css'

const projects: Project[] = [
  { id: 'local', name: 'Local', path: '/fixture/app', created_at: 1, last_opened_at: 1 },
  { id: 'wsl', name: 'WSL', path: '\\\\wsl.localhost\\Ubuntu\\home\\app', created_at: 1, last_opened_at: 1 },
  { id: 'ssh', name: 'SSH', path: 'ssh://c1/home/app', kind: 'ssh', connection_id: 'c1', created_at: 1, last_opened_at: 1 },
]
const disk = new Map<string, string>()
const cleanups: unknown[] = []

export function Settings({ project, workspace }: { project: Project; workspace: boolean }) {
  const settings = useTerminalIntegrationSettings(workspace ? 'workspace' : 'user', project, 0)
  const profilesRef = useRef<HTMLDivElement>(null)
  return <TerminalSettingsSection
    match={(...words) => words.includes('shellPrewarmCount')}
    workspaceLocked={workspace} currentProject={project}
    fonts={DEFAULT_FONT_SETTINGS} onFontChange={() => {}}
    terminal={loadTerminalProfileSettings()} onTerminalChange={() => {}}
    profilesRef={profilesRef} settings={settings}
  />
}

export default function Page() {
  const [kind, setKind] = useState(0)
  const [windows, setWindows] = useState(true)
  const [workspace, setWorkspace] = useState(false)
  const [revision, setRevision] = useState(0)
  return <main className="h-full overflow-auto bg-bg p-5 text-ui text-fg">
    <div className="mb-5 flex flex-wrap gap-3">
      <button onClick={() => {
        const next = !windows
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: next ? 'Windows' : 'Linux' })
        setWindows(next)
      }}>{windows ? 'Windows' : 'Linux'}</button>
      <select aria-label="项目类型" value={kind} onChange={e => setKind(Number(e.target.value))}>
        {projects.map((project, index) => <option key={project.id} value={index}>{project.name}</option>)}
      </select>
      <button onClick={() => setWorkspace(value => !value)}>{workspace ? '工作区作用域' : '用户作用域'}</button>
      <button onClick={() => setRevision(value => value + 1)}>重新打开设置</button>
      <button onClick={() => { document.documentElement.dataset.theme = 'light'; useLocaleStore.getState().setLanguage('en') }}>English / light</button>
    </div>
    <div className="settings-shell flex flex-col gap-6">
      <Settings key={`${kind}-${workspace}-${revision}`} project={projects[kind]} workspace={workspace} />
    </div>
    <ConfirmDialog />
  </main>
}

if (import.meta.env.MODE === 'web-test') {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Windows' })
  projects.forEach(trustProject)
  useLocaleStore.getState().setLanguage('zh-CN')
  Object.assign(window, { shellPrewarmFixture: { disk, cleanups } })
  mockIPC((command, args) => {
    const values = args as { path?: string; content?: string }
    if (command === 'default_settings_path') return '/fixture/default-settings.json'
    if (command === 'read_file' || command === 'ssh_read_file') {
      const text = disk.get(values.path!)
      if (text === undefined) throw new Error('missing file')
      return text
    }
    if (command === 'write_file' || command === 'ssh_write_file') {
      disk.set(values.path!, values.content!)
      return
    }
    if (command === 'ssh_workspace_status') return true
    if (command === 'cleanup_terminal_paste' || command === 'ssh_cleanup_terminal_paste') {
      cleanups.push({ command, ...args })
      return 0
    }
    throw new Error(`Unexpected fixture command: ${command}`)
  })
  createRoot(document.getElementById('root')!).render(<Page />)
}
