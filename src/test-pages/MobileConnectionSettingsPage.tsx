import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import MobileConnectionSettings from '../components/settings/MobileConnectionSettings'
import { SettingItem } from '../components/SettingsLayout'
import ChoiceDialog from '../components/ChoiceDialog'
import '../App.css'

let saved: { port: number; configured: boolean; password: string | null } = {
  port: 48764, configured: false, password: null,
}
let activePort: number | null = null
const status = () => ({ port: activePort, paired: false, fingerprint: activePort ? '0123456789abcdef'.repeat(4) : null })

export default function Page() {
  const [revision, setRevision] = useState(0)
  return <main className="h-full overflow-auto bg-bg p-5 text-ui text-fg">
    <p className="mb-4">Android 移动连接 · 内存验收，不开启监听端口</p>
    <div className="mb-4 flex flex-wrap gap-3">
      <button onClick={() => setRevision(value => value + 1)}>重新打开设置</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }}>切换主题</button>
      <button onClick={() => { document.documentElement.style.setProperty('--ui-font-size', '20px'); document.documentElement.style.setProperty('--ui-font-size-sm', '19px') }}>放大字号</button>
    </div>
    <div className="flex flex-col gap-5">
      <SettingItem title="远程连接" description="集中管理 SSH 主机与远端服务。"><button className="setting-control">管理远程连接…</button></SettingItem>
      <MobileConnectionSettings key={revision} />
    </div>
    <ChoiceDialog />
  </main>
}

if (import.meta.env.MODE === 'web-test') {
  mockIPC((command, args) => {
    if (command === 'mobile_saved_settings') return saved
    if (command === 'mobile_status') return status()
    if (command === 'mobile_stop') { activePort = null; return null }
    if (command === 'mobile_start') {
      const values = args as { port: number; code: string | null }
      saved = { port: values.port, configured: true, password: values.code ?? saved.password }
      activePort = values.port
      return status()
    }
    throw new Error(`Unexpected fixture command: ${command}`)
  })
  createRoot(document.getElementById('root')!).render(<Page />)
}
