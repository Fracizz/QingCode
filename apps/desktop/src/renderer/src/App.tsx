import { useEffect, useState } from 'react'
import type { SshTarget } from '../../shared/backendApi'
import { ChatPanel } from './components/ChatPanel'
import { CredentialDialog } from './components/CredentialDialog'
import { DirectoryPicker } from './components/DirectoryPicker'
import { HostKeyDialog } from './components/HostKeyDialog'
import { LegacyDialog } from './components/LegacyImport'
import { MobileSettingsDialog } from './components/MobileSettings'
import { Notice } from './components/Notice'
import { Sidebar } from './components/shell/Sidebar'
import { StatusBar } from './components/shell/StatusBar'
import { TitleBar } from './components/shell/TitleBar'
import { TargetForm } from './components/TargetForm'
import { useBootSplash } from './hooks/useBootSplash'
import { useCodex } from './store/codex'
import { useLegacy } from './store/legacy'
import { useProjects } from './store/projects'
import { useRateLimits } from './store/rateLimits'
import { useTargets, type ConnectCredentials } from './store/targets'
import { useUi } from './store/ui'

/**
 * 外壳布局（docs/design/ui-shell.md）：
 * ┌ TitleBar：品牌 + 侧栏开关 │ 目标 › 项目 › 会话 │ 额度 │ 系统窗口按钮 ┐
 * ├ Sidebar：目标切换器 / 项目→会话树 / 底部入口 │ Main：消息流 + 输入框 ┤
 * └ StatusBar：连接状态 · Codex 进程 · 当前目录 · 版本 ┘
 */
export default function App() {
  const entered = useBootSplash()

  const targets = useTargets((s) => s.targets)
  const states = useTargets((s) => s.states)
  const selectedId = useTargets((s) => s.selectedId)
  const prompts = useTargets((s) => s.prompts)
  const load = useTargets((s) => s.load)
  const select = useTargets((s) => s.select)
  const connect = useTargets((s) => s.connect)
  const disconnect = useTargets((s) => s.disconnect)
  const forgetSecret = useTargets((s) => s.forgetSecret)
  const respondHostKey = useTargets((s) => s.respondHostKey)

  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const pickerOpen = useUi((s) => s.directoryPickerOpen)

  const [targetForm, setTargetForm] = useState<{ open: boolean; editing: SshTarget | null }>({
    open: false,
    editing: null,
  })
  const [credentialTarget, setCredentialTarget] = useState<SshTarget | null>(null)
  const [rememberPrefs, setRememberPrefs] = useState<Record<string, boolean>>({})
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => useRateLimits.getState().init(), [])

  useEffect(() => {
    void load().then(() => {
      // 本机目标无需凭据，启动即连，省去用户每次手动点一次"连接"。smoke 只验证通道，不拉起 daemon。
      const state = useTargets.getState()
      if (!window.qn?.isSmoke && state.selectedId === 'local' && !state.states.local) {
        void state.connect('local')
      }
    })
    void useLegacy.getState().detectNow()
    return useCodex.getState().init()
  }, [load])

  useEffect(() => {
    useCodex.getState().setContext(selectedId, null)
    useRateLimits.getState().setActiveTarget(selectedId)
  }, [selectedId])

  // 全局快捷键：Ctrl+B 侧栏、Ctrl+N 新会话。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'b') {
        event.preventDefault()
        useUi.getState().toggleSidebar()
      } else if (key === 'n') {
        event.preventDefault()
        void useCodex.getState().newThread()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const requestConnect = (id: string) => {
    const target = targets.find((item) => item.id === id)
    if (!target) return
    const state = states[id]?.state ?? 'idle'
    if (state === 'ready' || state === 'connecting' || state === 'deploying') return
    if (target.kind === 'ssh' && target.auth.kind !== 'agent') {
      setCredentialTarget(target)
      return
    }
    void connect(id)
  }

  const onSelect = (id: string) => {
    select(id)
    requestConnect(id)
  }

  const onSaved = (target: SshTarget, credentials: ConnectCredentials) => {
    setRememberPrefs((prefs) => ({ ...prefs, [target.id]: credentials.remember === true }))
    select(target.id)
    if (credentials.password || credentials.passphrase) {
      void connect(target.id, credentials)
    } else if (target.kind === 'ssh' && target.auth.kind !== 'agent') {
      setCredentialTarget(target)
    } else {
      void connect(target.id)
    }
  }

  const openAddTarget = () => setTargetForm({ open: true, editing: null })
  const hostKeyPrompt = prompts[0]

  return (
    <div
      className="qn-shell flex h-screen w-screen flex-col overflow-hidden bg-qn-bg text-qn-text"
      data-entered={entered}
    >
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed && (
          <Sidebar
            onAdd={openAddTarget}
            onEdit={(target) => setTargetForm({ open: true, editing: target })}
            onImport={() => useLegacy.getState().open()}
            onMobile={() => setMobileOpen(true)}
            onSelect={onSelect}
            onConnect={requestConnect}
            onDisconnect={(id) => void disconnect(id)}
            onForgetSecret={(id) => void forgetSecret(id)}
          />
        )}
        <ChatPanel onConnect={requestConnect} onAddTarget={openAddTarget} />
      </div>
      <StatusBar onConnect={requestConnect} />

      {targetForm.open && (
        <TargetForm
          initial={targetForm.editing ?? undefined}
          onClose={() => setTargetForm({ open: false, editing: null })}
          onSaved={onSaved}
        />
      )}
      {credentialTarget && (
        <CredentialDialog
          key={credentialTarget.id}
          target={credentialTarget}
          initialRemember={rememberPrefs[credentialTarget.id] ?? false}
          onClose={() => setCredentialTarget(null)}
          onSubmit={(credentials) => {
            const target = credentialTarget
            setCredentialTarget(null)
            setRememberPrefs((prefs) => ({ ...prefs, [target.id]: credentials.remember === true }))
            void connect(target.id, credentials)
          }}
        />
      )}
      {hostKeyPrompt && (
        <HostKeyDialog
          key={hostKeyPrompt.promptId}
          prompt={hostKeyPrompt}
          onRespond={(accept) => void respondHostKey(hostKeyPrompt.promptId, accept)}
        />
      )}
      {pickerOpen && (
        <DirectoryPicker
          targetId={selectedId}
          onClose={() => useUi.getState().closeDirectoryPicker()}
          onConfirm={(path) => {
            useUi.getState().closeDirectoryPicker()
            void useProjects.getState().add(selectedId, path)
          }}
        />
      )}
      <LegacyDialog />
      {mobileOpen && <MobileSettingsDialog onClose={() => setMobileOpen(false)} />}
      <Notice />
    </div>
  )
}
