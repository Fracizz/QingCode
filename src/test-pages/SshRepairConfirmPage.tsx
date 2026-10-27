import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ConfirmDialog from '../components/ConfirmDialog'
import { confirmDialogWithCheckbox } from '../store/confirmStore'
import { SSH_REPAIR_CHECKBOX, SSH_REPAIR_DETAIL } from '../lib/sshWindowsRepair'
import '../App.css'

export default function SshRepairConfirmPage() {
  const [result, setResult] = useState<unknown>(null)
  return <main className="h-full bg-bg p-5 text-fg">
    <h1 className="text-ui-lg font-semibold">Windows SSH 修复确认 Web 测试</h1>
    <p className="mt-2 text-ui-sm text-fg-muted">真实确认框与样式；内存场景，不连接或修改远端主机。</p>
    <button className="mt-4 rounded border border-border-strong px-3 py-2" onClick={async () => {
      setResult(await confirmDialogWithCheckbox({
        title: '重启远端服务',
        message: '重启会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。',
        detail: '检测到 4 条 SSH 连接；配置将从 2390 字节精简至 430 字节。',
        confirmLabel: '重启',
        checkbox: { label: SSH_REPAIR_CHECKBOX, detail: SSH_REPAIR_DETAIL, defaultChecked: true },
      }))
    }}>模拟 Windows SSH 修复</button>
    <pre data-testid="repair-result" className="mt-4">{JSON.stringify(result)}</pre>
    <ConfirmDialog />
  </main>
}

const root = document.getElementById('root')!
if (import.meta.env.MODE === 'web-test') createRoot(root).render(<SshRepairConfirmPage />)
else root.textContent = '请运行 pnpm test:web，使用独立的 Web 测试服务。'
