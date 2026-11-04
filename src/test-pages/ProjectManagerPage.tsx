import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectManager from '../components/ProjectManager'
import ConfirmDialog from '../components/ConfirmDialog'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import {
  resetProjectManagerFixture,
  useUIStore,
  useWebTestOperations,
} from './projectManagerAdapters'
import '../App.css'

export default function ProjectManagerPage() {
  const open = useUIStore(state => state.projectManagerOpen)
  const operations = useWebTestOperations(state => state.operations)
  const [generation, setGeneration] = useState(0)
  const [theme, setTheme] = useState('dark')
  const language = useLocaleStore(state => state.language)
  const buttonClass = 'rounded border border-border-strong px-3 py-1 text-ui-sm hover:bg-bg-hover'
  return (
    <>
      <main className="h-full bg-bg p-5 text-fg">
        <h1 className="text-ui-lg font-semibold">项目管理 Web 测试</h1>
        <p className="mt-2 text-ui-sm text-fg-muted">
          真实组件与样式 · 16 个固定项目 + 1 个临时项目 · 内存数据，刷新即重置
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            className={buttonClass}
            onClick={() => useUIStore.getState().openProjectManager()}
          >
            打开项目管理
          </button>
          <button
            className={buttonClass}
            onClick={() => {
              resetProjectManagerFixture()
              setGeneration(value => value + 1)
            }}
          >
            重置测试数据
          </button>
          <label className="text-ui-sm">
            主题{' '}
            <select
              aria-label="测试主题"
              value={theme}
              onChange={event => {
                setTheme(event.target.value)
                document.documentElement.dataset.theme = event.target.value
              }}
              className="rounded bg-bg-active px-2 py-1"
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
              <option value="olive">橄榄绿</option>
            </select>
          </label>
          <label className="text-ui-sm">
            语言{' '}
            <select
              aria-label="测试语言"
              value={language}
              onChange={async event => {
                const value = event.target.value
                await ensureBuiltinLocaleLoaded(value)
                useLocaleStore.setState({ language: value })
              }}
              className="rounded bg-bg-active px-2 py-1"
            >
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <p className="mt-4 text-ui-sm text-fg-muted">
          支持来源筛选、路径与连接搜索、显示状态、分页、排序和批量选择。新建、保存等外部操作仅记录调用。
        </p>
        <h2 className="mt-6 font-semibold text-ui">操作记录</h2>
        <pre data-testid="operation-log" className="mt-2 whitespace-pre-wrap font-mono text-ui-sm">
          {JSON.stringify(operations, null, 2)}
        </pre>
      </main>
      {open && <ProjectManager key={generation} />}
      <ConfirmDialog />
    </>
  )
}

// Do not boot App/main.tsx: no session hydration, DB loading, SSH connection, or persistence.
useLocaleStore.setState({ language: 'zh-CN' })
const root = document.getElementById('root')!
if (import.meta.env.MODE !== 'web-test') {
  root.textContent = '请运行 pnpm test:web，使用独立的 Web 测试服务。'
} else {
  createRoot(root).render(
    <StrictMode>
      <ProjectManagerPage />
    </StrictMode>
  )
}
