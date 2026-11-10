import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import Toaster from '../components/Toaster'
import { runSshOpening, cancelSshOpening } from '../store/sshOpeningStore'
import { beginServerOperation, reportServerOperation, finishServerOperation, useServerOperationStore } from '../store/serverOperationStore'
import { useUIStore, useProjectStore } from './projectManagerAdapters'
import { useTransferStore } from '../store/transferStore'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import type { Project } from '../types'
import type { SshOpeningStage } from '../store/sshOpeningStore'
import type { SshServerState } from '../lib/sshServerStatus'
import '../App.css'

const project: Project = { id: 'operation-fixture', name: 'ai-auto-test-dev', path: 'ssh://operation/home/code/ai-auto-test-dev', kind: 'ssh', created_at: 1, last_opened_at: 1 }
let report: ((stage: SshOpeningStage, state?: SshServerState) => void) | undefined
export default function Page() {
  const [mode, setMode] = useState('dark')
  const updateRoot = useUIStore(s => s.serverUpdateRootUri)
  const install = () => {
    useServerOperationStore.setState({ tasks: {} })
    void runSshOpening(project, async (_signal, next) => {
      report = next
      return new Promise(() => {})
    }).catch(() => {})
  }
  return <main className="h-full bg-bg p-5 text-fg">
    <p>Server 安装与更新进度 · 内存场景，不连接远端</p>
    <div className="mt-4 flex flex-wrap gap-3">
      <button onClick={install}>模拟首次安装</button>
      <button onClick={() => report?.('service', { rootUri: project.path, connectionId: 'operation', phase: 'installing', mode: 'server', connectionMode: 'server', transport: 'daemon', version: null, reason: null })}>安装第 3 步</button>
      <button onClick={() => report?.('files')}>验证第 4 步</button>
      <button onClick={() => {
        cancelSshOpening()
        beginServerOperation(project.path, project.name, 'update')
        reportServerOperation(project.path, 2, '正在本机下载并校验服务包…')
      }}>模拟后台更新</button>
      <button onClick={() => {
        const rootUri = 'ssh://parallel/home/code/nem-panel'
        beginServerOperation(rootUri, 'nem-panel', 'update')
        reportServerOperation(rootUri, 2, '正在本机下载并校验服务包…')
      }}>添加并行更新</button>
      <button onClick={() => {
        for (let index = 0; index < 6; index++) {
          const rootUri = `ssh://parallel-${index}/home/code/project-${index}`
          beginServerOperation(rootUri, `并行更新项目-${index}`, 'update')
        }
      }}>添加多条更新</button>
      <button onClick={() => {
        void runSshOpening({ ...project, id: 'opening-parallel', name: '正在打开的项目', path: 'ssh://opening/home/code/project' }, async () => new Promise(() => {})).catch(() => {})
      }}>并行打开项目</button>
      <button onClick={() => {
        useProjectStore.setState({ toasts: [{ id: 'parallel-toast', kind: 'success', text: '远端服务更新完成' }] })
        useTransferStore.setState({ tasks: [{ taskId: 'parallel-transfer', status: 'running', completedFiles: 0, completedBytes: 0, completedPaths: [], currentBytes: 512, currentTotalBytes: 1024,
          request: { direction: 'upload', paths: ['/tmp/example.txt'], destination: 'ssh://operation/tmp/example.txt' } }] })
      }}>添加通知与传输</button>
      <button onClick={() => reportServerOperation(project.path, 3, '正在通过 SSH 上传并校验服务包…')}>更新第 3 步</button>
      <button onClick={() => reportServerOperation(project.path, 4, '正在验证远端服务与配对身份…')}>更新第 4 步</button>
      <button onClick={() => finishServerOperation(project.path)}>模拟成功</button>
      <button onClick={() => finishServerOperation(project.path, 'SSH authentication failed; manual authorization required')}>模拟失败</button>
      <button onClick={async () => {
        const next = mode === 'dark' ? 'light' : 'dark'
        setMode(next)
        document.documentElement.dataset.theme = next
        await ensureBuiltinLocaleLoaded('en')
        useLocaleStore.setState({ language: next === 'light' ? 'en' : 'zh-CN' })
      }}>切换语言主题</button>
    </div>
    <output data-testid="manual-update-root">{updateRoot}</output>
    <Toaster />
  </main>
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.setState({ language: 'zh-CN' })
  useProjectStore.setState(state => ({ sshConnections: [
    ...state.sshConnections,
    { ...state.sshConnections[0], id: 'operation', name: 'windev' },
    { ...state.sshConnections[0], id: 'parallel', name: 'Linux 开发机' },
  ] }))
  createRoot(document.getElementById('root')!).render(<Page />)
}
