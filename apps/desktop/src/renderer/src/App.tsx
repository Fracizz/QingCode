import { useEffect, useRef, useState } from 'react'
import type { DirectTarget, SshTarget } from '../../shared/backendApi'
import { ChatPanel } from './components/ChatPanel'
import { CredentialDialog } from './components/CredentialDialog'
import { DirectoryPicker } from './components/DirectoryPicker'
import { HostKeyDialog } from './components/HostKeyDialog'
import { LegacyDialog } from './components/LegacyImport'
import { MobileSettingsDialog } from './components/MobileSettings'
import { Notice } from './components/Notice'
import { TooltipProvider } from './components/primitives'
import { Sidebar } from './components/shell/Sidebar'
import { TitleBar } from './components/shell/TitleBar'
import { TargetForm } from './components/TargetForm'
import { useWorkspaceScope, WorkspaceDock } from './components/shell/WorkspaceDock'
import { QuickOpen } from './features/explorer'
import { closeSettings, openSettings, SettingsDialog, useSettings, useSettingsDialog } from './features/settings'
import { useWorkspaceWatch } from './hooks/useWorkspaceWatch'
import { useDock } from './store/dock'
import { useBootSplash } from './hooks/useBootSplash'
import { useCodex } from './store/codex'
import { useLegacy } from './store/legacy'
import { useProjects } from './store/projects'
import { useRateLimits } from './store/rateLimits'
import { useTargets, type ConnectCredentials } from './store/targets'
import { useUi } from './store/ui'

/**
 * 外壳布局（docs/design/ui-shell.md，优先参考 Codex 桌面版）：
 * ┌ TitleBar：侧栏开关 + 品牌 │ 目标 · 额度胶囊 │ 系统窗口按钮 ┐
 * ├ Sidebar：目标切换 / 新会话 / 项目→会话树 / 底部入口 │ Main：会话顶栏 + 消息流 + 输入框 ┤
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

  const [targetForm, setTargetForm] = useState<{ open: boolean; editing: SshTarget | DirectTarget | null }>({
    open: false,
    editing: null,
  })
  const [credentialTarget, setCredentialTarget] = useState<SshTarget | null>(null)
  const [rememberPrefs, setRememberPrefs] = useState<Record<string, boolean>>({})
  const [mobileOpen, setMobileOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const workspace = useWorkspaceScope()
  const settingsDialog = useSettingsDialog()
  const autoConnectDone = useRef(false)
  // 必须在首次渲染时读出：下面"记住上次目标"的 effect 挂载时会先把初始值 'local' 写回去。
  const lastTargetAtStartup = useRef<string | null | undefined>(undefined)
  if (lastTargetAtStartup.current === undefined) {
    try {
      lastTargetAtStartup.current = localStorage.getItem('qn-last-target')
    } catch {
      lastTargetAtStartup.current = null
    }
  }

  useWorkspaceWatch()

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
    void useSettings.getState().load()
    return useCodex.getState().init()
  }, [load])

  useEffect(() => {
    useCodex.getState().setContext(selectedId, null)
    useRateLimits.getState().setActiveTarget(selectedId)
  }, [selectedId])

  // 全局快捷键：Ctrl+B 侧栏、Ctrl+N 新会话（草稿态，发第一条消息时才创建）、Ctrl+P 快速打开文件；
  // Ctrl+Shift+E/F/G 切换右侧资源管理器 / 搜索 / 源代码管理。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (event.shiftKey) {
        const tool = key === 'e' ? 'explorer' : key === 'f' ? 'search' : key === 'g' ? 'git' : null
        if (tool) {
          event.preventDefault()
          useDock.getState().toggleTool(tool)
        }
        return
      }
      if (key === ',') {
        event.preventDefault()
        openSettings()
      } else if (key === 'p') {
        event.preventDefault()
        setQuickOpen(true)
      } else if (key === 'b') {
        event.preventDefault()
        useUi.getState().toggleSidebar()
      } else if (key === 'n') {
        event.preventDefault()
        useCodex.getState().startDraft()
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
      // 已保存密码/口令时直接连（backend 合并已保存凭据）；认证失败再弹框让用户重输。
      if (!target.hasSavedSecret) {
        setCredentialTarget(target)
        return
      }
      void connect(id).then(() => {
        const info = useTargets.getState().states[id]
        if (info?.state === 'error' && /auth|认证|密码|password|口令|passphrase/i.test(info.detail ?? '')) {
          setCredentialTarget(target)
        }
      })
      return
    }
    void connect(id)
  }

  /** 带"记住"连接成功后刷新目标列表，让"已保存密码"状态立即生效。 */
  const connectAndRefresh = (id: string, credentials: ConnectCredentials) =>
    connect(id, credentials).then(() => {
      if (credentials.remember) void load()
    })

  const onSelect = (id: string) => {
    select(id)
    requestConnect(id)
  }

  // 记住上次使用的目标；启动时回到该目标，设置里开了"启动时自动连接上次目标"时再连一次。
  useEffect(() => {
    try {
      localStorage.setItem('qn-last-target', selectedId)
    } catch {
      // 存储不可用时只是不能自动连接。
    }
  }, [selectedId])
  const settingsLoaded = useSettings((s) => s.loaded)
  // 界面密度：样式在 styles.css 里按 html[data-density] 生效。
  const density = useSettings((s) => s.settings.general.density)
  useEffect(() => {
    document.documentElement.dataset['density'] = density
  }, [density])
  const autoConnectLast = useSettings((s) => s.settings.general.autoConnectLast)
  useEffect(() => {
    if (autoConnectDone.current || !settingsLoaded || targets.length === 0 || window.qn?.isSmoke) return
    autoConnectDone.current = true
    const last = lastTargetAtStartup.current
    if (!last || last === 'local' || !targets.some((item) => item.id === last)) return
    // 没开自动连接时也回到上次的目标（不连接），用户点一下"连接"即可，不必每次重新切换。
    select(last)
    if (autoConnectLast) requestConnect(last)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在首次满足条件时执行一次
  }, [settingsLoaded, targets, autoConnectLast])

  const onSaved = (target: SshTarget | DirectTarget, credentials: ConnectCredentials) => {
    setRememberPrefs((prefs) => ({ ...prefs, [target.id]: credentials.remember === true }))
    select(target.id)
    // 走到这里说明试连已通过（密码来自输入或已保存），直接连接即可。
    void (async () => {
      // 改过配置的活动连接要先断开，否则 backend 认为已就绪而沿用旧配置。
      const state = useTargets.getState().states[target.id]?.state
      if (state && state !== 'idle') await disconnect(target.id)
      await connectAndRefresh(target.id, credentials)
    })()
  }

  const openAddTarget = () => setTargetForm({ open: true, editing: null })
  const hostKeyPrompt = prompts[0]

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
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
            onSettings={() => openSettings()}
            onSelect={onSelect}
            onConnect={requestConnect}
            onDisconnect={(id) => void disconnect(id)}
            onForgetSecret={(id) => void forgetSecret(id)}
          />
        )}
        <ChatPanel onConnect={requestConnect} onAddTarget={openAddTarget} />
        <WorkspaceDock />
      </div>

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
          initialRemember={rememberPrefs[credentialTarget.id] ?? true}
          onClose={() => setCredentialTarget(null)}
          onSubmit={(credentials) => {
            const target = credentialTarget
            setCredentialTarget(null)
            setRememberPrefs((prefs) => ({ ...prefs, [target.id]: credentials.remember === true }))
            void connectAndRefresh(target.id, credentials)
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
      <SettingsDialog
        open={settingsDialog.open}
        onClose={closeSettings}
        initialSection={settingsDialog.section}
        onEditTarget={(target) => {
          closeSettings()
          setTargetForm({ open: true, editing: target })
        }}
        onRemoveTarget={(id) => void useTargets.getState().remove(id)}
      />
      {quickOpen && !('reason' in workspace) && (
        <QuickOpen
          targetId={workspace.targetId}
          root={workspace.cwd}
          open={quickOpen}
          onClose={() => setQuickOpen(false)}
        />
      )}
      <Notice />
    </div>
    </TooltipProvider>
  )
}
