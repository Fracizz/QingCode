import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import RunConfigDiscovery from '../components/RunConfigDiscovery'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import { useRunConfigStore, type RunConfig } from '../store/runConfigStore'
import type { Project } from '../types'
import '../App.css'

const project: Project = { id: 'discovery', name: 'discovery-fixture', path: '/fixture', created_at: 1, last_opened_at: 1 }
const files: Record<string, string> = {
  '/fixture/package.json': JSON.stringify({ packageManager: 'pnpm@11.0.8', scripts: { dev: 'vite', build: 'vite build', 'bad&name': 'echo nope' } }),
  '/fixture/api/package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
  '/fixture/broken/package.json': '{ invalid json',
}
const initialConfigs: RunConfig[] = [{ id: 'existing', name: 'existing-build', tasks: [{ id: 'build', type: 'command', target: 'pnpm run build' }] }]
files['/fixture/.qingcode/run.json'] = JSON.stringify({ configs: initialConfigs })
const state = { commands: [] as string[], writes: 0, failWrite: false }

export default function Page() {
  const [open, setOpen] = useState(true)
  const [version, setVersion] = useState(0)
  const configs = useRunConfigStore(s => s.configsByProject[project.id])
  return <main className="h-full overflow-auto bg-bg p-4 text-fg">
    <h1 className="mb-3 text-ui-lg">运行配置发现 · 真实组件 / 内存文件</h1>
    <div className="mb-3 flex flex-wrap gap-4 text-ui-sm">
      <button onClick={() => setOpen(true)}>打开发现</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }}>切换主题</button>
      <button onClick={async () => {
        const language = useLocaleStore.getState().language === 'en' ? 'zh-CN' : 'en'
        await ensureBuiltinLocaleLoaded(language)
        useLocaleStore.getState().setLanguage(language)
      }}>切换语言</button>
      <label><input aria-label="模拟保存失败" type="checkbox" onChange={event => { state.failWrite = event.target.checked }} />模拟保存失败</label>
      <button onClick={() => {
        state.commands = []; state.writes = 0; state.failWrite = false
        files['/fixture/.qingcode/run.json'] = JSON.stringify({ configs: initialConfigs })
        useRunConfigStore.setState({ configsByProject: {}, loadedProjects: new Set() })
        setVersion(value => value + 1); setOpen(true)
      }}>重置数据</button>
    </div>
    <pre data-testid="saved-configs" className="whitespace-pre-wrap text-ui-sm">{JSON.stringify(configs ?? [], null, 2)}</pre>
    {open && <RunConfigDiscovery key={version} project={project} onClose={() => setOpen(false)} />}
  </main>
}

if (import.meta.env.DEV && import.meta.env.MODE === 'web-test') {
  mockIPC((command, payload = {}) => {
    const args = payload as Record<string, unknown>
    state.commands.push(command)
    const path = String(args.path)
    if (command === 'scan_directory') {
      const entries = new Map<string, { name: string; path: string; is_dir: boolean }>()
      for (const key of Object.keys(files)) {
        if (!key.startsWith(`${path}/`)) continue
        const [name, descendant] = key.slice(path.length + 1).split('/')
        entries.set(name, { name, path: `${path}/${name}`, is_dir: descendant !== undefined })
      }
      return [...entries.values()]
    }
    if (command === 'read_file_slice') {
      const text = files[path]
      if (text === undefined) throw new Error('Missing fixture file')
      const size = new TextEncoder().encode(text).length
      return { offset: 0, len: size, file_size: size, eof: true, text }
    }
    if (command === 'read_file') {
      if (!(path in files)) throw new Error('Missing fixture file')
      return files[path]
    }
    if (command === 'write_file') {
      if (state.failWrite) throw new Error('Fixture write denied')
      if (path !== '/fixture/.qingcode/run.json') throw new Error('Unexpected fixture write')
      files[path] = String(args.content); state.writes++
      return
    }
    throw new Error(`Unexpected fixture IPC: ${command}`)
  })
  Object.assign(window, { runDiscoveryFixture: state })
  useLocaleStore.setState({ language: 'zh-CN' })
  createRoot(document.getElementById('root')!).render(<Page />)
}
