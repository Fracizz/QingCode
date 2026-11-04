import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import SshOpeningDialog from '../components/SshOpeningDialog'
import { cancelSshOpening, runSshOpening, SshPreparationError } from '../store/sshOpeningStore'
import { useProjectStore, useWebTestOperations } from './projectManagerAdapters'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import type { Project } from '../types'
import '../App.css'

const project: Project = { id: 'recovery-fixture', name: 'nem-panel', kind: 'ssh', path: 'ssh://fixture/home/code/nem-panel', created_at: 1, last_opened_at: 1 }
const valid = { expectedVersion: '0.1.14-beta.9', packageVersion: '0.1.14-beta.9', sourcePath: 'C:/Downloads/QingCode/servers/qingcode-server-x86_64', directory: 'C:/Downloads/QingCode/servers', problem: null }
const old = { ...valid, packageVersion: '0.1.14-beta.1', sourcePath: 'C:/Users/test/AppData/Local/QingCode/servers/qingcode-server-x86_64', problem: 'server 包版本不匹配：文件版本 0.1.14-beta.1，客户端需要 0.1.14-beta.9' }
let scenario = 'invalid'
let settings = '{"version":1,"custom":{},"ssh.server.offlineDir":"C:/old"}'
let saves = 0
function showError() {
  void runSshOpening(project, async (_signal, report) => {
    report('service')
    throw new SshPreparationError('Server 模式：远端服务程序版本不匹配，远端 0.1.14-beta.1，本端 0.1.14-beta.9')
  }).catch(() => {})
}
function Page() {
  const [mode, setMode] = useState(scenario)
  const operations = useWebTestOperations(s => s.operations)
  useEffect(showError, [])
  useEffect(() => { if (operations.some(op => op.action === 'switchProject')) cancelSshOpening() }, [operations])
  const button = 'rounded border border-border-strong px-3 py-2 text-ui'
  return <main className="h-full overflow-auto bg-bg p-4 text-fg">
    <div className="flex flex-wrap gap-3">
      <select aria-label="测试服务包" value={mode} onChange={e => { scenario = e.target.value; setMode(scenario) }}>
        <option value="invalid">旧版本目录</option><option value="valid">正确版本目录</option><option value="cancel">取消选择</option><option value="network">下载失败</option>
      </select>
      <button className={button} onClick={showError}>重新模拟错误</button>
      <button className={button} onClick={async () => { await ensureBuiltinLocaleLoaded('en'); useLocaleStore.getState().setLanguage(useLocaleStore.getState().language === 'en' ? 'zh-CN' : 'en') }}>切换语言</button>
      <button className={button} onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }}>切换主题</button>
    </div>
    <output data-testid="recovery-result" className="mt-3 block">{JSON.stringify({ saves, retries: operations.filter(op => op.action === 'switchProject').length, settings })}</output>
    <SshOpeningDialog />
  </main>
}
if (import.meta.env.DEV && import.meta.env.MODE === 'web-test') {
  mockIPC((command, args) => {
    const params = args as Record<string, unknown> | undefined
    if (command === 'plugin:dialog|open') return scenario === 'cancel' ? null : 'C:/Downloads/QingCode'
    if (command === 'ssh_server_package_info') return params?.dir ? scenario === 'invalid' ? old : valid : old
    if (command === 'ssh_download_server_package') {
      if (scenario === 'network') throw new Error('Network offline')
      return valid
    }
    if (command === 'ssh_reset_server_failure') return null
    if (command === 'ssh_read_file') return settings
    if (command === 'ssh_write_file') { settings = String(params?.content); saves++; return null }
    throw new Error(`Unexpected recovery fixture command: ${command}`)
  })
  useLocaleStore.getState().setLanguage('zh-CN')
  useProjectStore.setState({ currentProject: project })
  createRoot(document.getElementById('root')!).render(<Page />)
}
