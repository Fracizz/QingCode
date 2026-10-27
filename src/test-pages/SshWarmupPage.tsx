import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectKindIcon } from '../components/ProjectKindMark'
import { useSshWarmupStore } from '../store/sshWarmupStore'
import { useI18n } from '../lib/i18n'
import type { WarmupPhase } from '../lib/sshWarmupQueue'
import '../App.css'

const phases: WarmupPhase[] = ['queued', 'preparing', 'ready', 'attention', 'failed']

export default function SshWarmupPage() {
  const { language, setLanguage } = useI18n()
  const [clicked, setClicked] = useState('')
  useEffect(() => {
    useSshWarmupStore.setState({
      statuses: new Map(
        phases.map(phase => [
          `ssh://fixture/${phase}`,
          { phase, ...(phase === 'failed' ? { detail: '测试连接不可达' } : {}) },
        ])
      ),
    })
    return () => useSshWarmupStore.setState({ statuses: new Map() })
  }, [])
  return (
    <main className="h-full bg-bg p-5 text-fg">
      <h1 className="text-ui-lg font-semibold">远程项目后台准备 Web 验收</h1>
      <p className="mt-2 text-ui-sm text-fg-muted">
        真实项目图标、状态及 Tooltip；内存场景，不连接远端。
      </p>
      <div className="my-4 flex gap-3">
        <button
          className="rounded border border-border-strong px-3 py-1"
          onClick={() => {
            document.documentElement.dataset.theme =
              document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
          }}
        >
          切换主题
        </button>
        <button
          className="rounded border border-border-strong px-3 py-1"
          onClick={() => setLanguage(language === 'en' ? 'zh-CN' : 'en')}
        >
          切换语言
        </button>
      </div>
      <div className="flex max-w-[700px] flex-wrap gap-2 border border-border p-3">
        {phases.map(phase => (
          <button
            key={phase}
            data-phase={phase}
            className="flex items-center gap-2 rounded bg-bg-sidebar px-3 py-2 hover:bg-bg-hover"
            onClick={() => setClicked(phase)}
          >
            <ProjectKindIcon
              project={{ kind: 'ssh', path: `ssh://fixture/${phase}` }}
              preparation
              size={14}
            />
            <span>project-{phase}</span>
          </button>
        ))}
      </div>
      <p role="status" className="mt-3">
        {clicked ? `已点击 ${clicked}` : '等待点击'}
      </p>
    </main>
  )
}

const root = document.getElementById('root')!
if (import.meta.env.MODE === 'web-test') createRoot(root).render(<SshWarmupPage />)
else root.textContent = '请运行 pnpm test:web，使用独立的 Web 测试服务。'
