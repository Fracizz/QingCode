import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { interfaceMetrics } from '../lib/interfaceMetrics'
import MobileConnectionSettings from '../components/settings/MobileConnectionSettings'
import { SettingItem } from '../components/SettingsLayout'
import ChoiceDialog from '../components/ChoiceDialog'
import '../App.css'

let saved: { port: number; configured: boolean; password: string | null } = {
  port: 48764, configured: false, password: null,
}
let activePort: number | null = null
const status = () => ({
  port: activePort,
  savedPort: saved.port,
  configured: saved.configured,
  enabled: activePort !== null,
  fingerprint: activePort ? '0123456789abcdef'.repeat(4) : null,
  devices: activePort ? [{ id: 'd1', name: 'Google Pixel 8', pairedAt: 1_790_000_000, online: true }] : [],
  addresses: activePort ? ['192.168.1.8', '10.0.0.5'] : [],
  computer: 'DEVBOX',
  error: null,
})
// A fixed finder-pattern-like matrix; the page only renders it.
const qr = { size: 21, modules: Array.from({ length: 21 * 21 }, (_, index) => ((index * 7) % 3 === 0 ? '1' : '0')).join('') }

export default function Page() {
  const [revision, setRevision] = useState(0)
  return <main className="h-full overflow-auto bg-bg p-5 text-ui text-fg">
    <p className="mb-4">Android 移动连接 · 内存验收，不开启监听端口</p>
    <div className="mb-4 flex flex-wrap gap-3">
      <button onClick={() => setRevision(value => value + 1)}>重新打开设置</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }}>切换主题</button>
      <button onClick={() => {
        const metrics = interfaceMetrics(20)
        document.documentElement.style.setProperty('--ui-font-size', `${metrics.fontSize}px`)
        document.documentElement.style.setProperty('--ui-font-size-sm', `${metrics.smallFontSize}px`)
        document.documentElement.style.setProperty('--ui-control-height', `${metrics.controlHeight}px`)
      }}>放大字号</button>
    </div>
    <div className="settings-shell">
    <div className="flex flex-col gap-5">
      <SettingItem title="远程连接" description="集中管理 SSH 主机与远端服务。"><button className="setting-control">管理远程连接…</button></SettingItem>
      <MobileConnectionSettings key={revision} />
    </div>
    </div>
    <ChoiceDialog />
  </main>
}

if (import.meta.env.MODE === 'web-test') {
  mockIPC((command, args) => {
    if (command === 'mobile_saved_settings') return saved
    if (command === 'mobile_status') return status()
    if (command === 'mobile_stop') { activePort = null; return status() }
    if (command === 'mobile_pairing_qr') return qr
    if (command === 'mobile_revoke_device') return status()
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
