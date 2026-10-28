import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import SshOpeningDialog from '../components/SshOpeningDialog'
import { runSshOpening, SshPreparationError } from '../store/sshOpeningStore'
import { useI18n, useLocaleStore } from '../lib/i18n'
import type { Project } from '../types'
import '../App.css'

const project: Project = {
  id: 'opening-fixture', name: 'nem-panel', path: 'ssh://fixture/D:/code/nem-panel',
  kind: 'ssh', created_at: 1, last_opened_at: 1,
}

export default function SshOpeningPage() {
  const { language, setLanguage } = useI18n()
  const [result, setResult] = useState('等待开始')
  const controls = useRef<{ finish: () => void; fail: () => void } | null>(null)
  const start = async () => {
    setResult('正在准备')
    try {
      await runSshOpening(project, async (_signal, report) => {
        report('service', {
          rootUri: project.path, connectionId: 'fixture', connectionMode: 'server',
          phase: 'handshaking', mode: 'server', transport: null, reason: null, version: null,
        })
        await new Promise<void>((resolve, reject) => {
          controls.current = {
            finish: () => { report('files'); resolve() },
            fail: () => reject(new SshPreparationError('测试握手失败：远端未响应')),
          }
        })
      })
      setResult('准备完成')
    } catch (error) {
      setResult(error instanceof DOMException && error.name === 'AbortError' ? '已取消' : '准备失败')
    }
  }
  return <main className="h-full bg-bg p-5 text-fg">
    <h1 className="text-ui-lg font-semibold">远程项目打开进度 Web 验收</h1>
    <p className="my-3 text-ui-sm text-fg-muted">复用真实进度对话框和计时状态；仅使用内存数据，不建立 SSH 连接。</p>
    <div className="flex flex-wrap gap-3 [&>button]:rounded [&>button]:border [&>button]:border-border-strong [&>button]:px-3 [&>button]:py-2">
      <button onClick={() => void start()}>模拟打开</button>
      <button onClick={() => controls.current?.finish()}>完成准备</button>
      <button onClick={() => controls.current?.fail()}>模拟失败</button>
      <button onClick={() => setLanguage(language === 'en' ? 'zh-CN' : 'en')}>切换语言</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }}>切换主题</button>
    </div>
    <label className="mt-5 block">当前项目编辑区<input aria-label="当前项目编辑区" className="ml-2 border border-border bg-bg px-2 py-1" /></label>
    <p data-testid="opening-result" className="mt-4">{result}</p>
    <SshOpeningDialog />
  </main>
}

const root = document.getElementById('root')!
if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.getState().setLanguage('zh-CN')
  createRoot(root).render(<SshOpeningPage />)
} else root.textContent = '请运行 pnpm test:web，使用独立的 Web 测试服务。'
