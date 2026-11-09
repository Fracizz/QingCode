import { hasBackend } from '../lib/runtimeCapabilities'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  FileText,
  FolderOpen,
  Globe,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  ShieldOff,
  X,
} from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import ContextMenu from './ContextMenu'
import SshImportDialog from './SshImportDialog'
import DirectAgentConnectionPanel from './DirectAgentConnectionPanel'
import DirectServerRecoveryPanel from './DirectServerRecoveryPanel'
import DirectSshFallback from './DirectSshFallback'
import { directAgentApi, type DirectAgentInfo } from '../lib/directAgent'
import { confirmDialog } from '../store/confirmStore'
import { confirmSshServerRestart } from '../lib/sshWindowsRepair'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { safeInvoke } from '../lib/tauri'
import { useI18n } from '../lib/i18n'
import {
  disconnectSshSession,
  forgetSshSessionSecrets,
  deleteSavedSshSecrets,
  saveSshSecrets,
  isSshConnectionAlive,
  isSshBackgroundSuspended,
  SSH_CONNECTION_INVALIDATED_EVENT,
  SSH_CONNECTION_DISCONNECTED_EVENT,
  listSshServerStates,
  listSshWorkspaceRoots,
  NEW_SSH_CONNECTION_ID,
  testSshConnection,
  probeSshHost,
  reconnectSshConnection,
  rememberSshSessionSecrets,
  resolveSshConnectionMode,
  sshConnectionIdFromUri,
  sshConnectionLabel,
  sshConnectionTarget,
  sshProjectDisplayPath,
  switchSshConnectionMode,
  type SshSessionSecrets,
  type SshWorkspaceRoot,
} from '../lib/sshWorkspace'
import { getSshServerEnabled } from '../lib/sshServerSettings'
import { connectionStatus, matchesConnection, groupConnectionProjects } from '../lib/remoteConnectionOverview'
import { normalizeProjectPath, restrictProject } from '../lib/workspaceTrust'
import {
  isAgentCommandUnavailable,
  parseSshServerState,
  sshServerIsDirect,
  sshServerModeKey,
  sshServerSwitchBlocker,
  sshServerTransportKey,
  type SshServerState,
  sshServerUsesGateway,
} from '../lib/sshServerStatus'
import {
  connectionFromForm,
  emptyConnectionForm,
  fingerprintStatus,
  formEqualsConnection,
  formFromConnection,
  runtimeConfigFromForm,
  targetChanged,
  validateConnectionForm,
  type SshConnectionForm,
} from '../lib/sshConnectionForm'
import type { Project, SshConnectionMode } from '../types'

const fieldClass =
  'min-w-0 w-full rounded border border-dialog-border bg-dialog-input px-2.5 py-1.5 text-ui text-fg outline-none placeholder:text-fg-dim focus:border-accent'
const labelClass = 'min-w-0 text-ui-sm font-medium text-dialog-label'
const helpClass = 'text-ui-sm leading-[var(--ui-line-height)] text-fg-muted'
const sectionTitleClass = 'flex items-center gap-1.5 text-ui font-semibold text-fg'
const valueBoxClass =
  'mt-1 flex items-center gap-2 rounded border border-dialog-border bg-dialog-input px-2.5 py-1.5 font-mono text-ui-sm text-fg'
const primaryButtonClass =
  'rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-50'
const secondaryButtonClass =
  'rounded border border-dialog-border px-3 py-1.5 text-ui text-fg hover:bg-bg-hover disabled:opacity-40'

type LogView = { rootUri: string; text: string; loading: boolean }
const NEW_AGENT_CONNECTION_ID = '__new_agent__'

/** 远程连接管理页：连接是跨项目资源，远程项目与远端服务都挂在连接下。 */
export default function RemoteConnectionsManager() {
  const { t } = useI18n()
  const connections = useProjectStore(s => s.sshConnections)
  const loadSshConnections = useProjectStore(s => s.loadSshConnections)
  const saveSshConnection = useProjectStore(s => s.saveSshConnection)
  const deleteSshConnection = useProjectStore(s => s.deleteSshConnection)
  const projects = useProjectStore(s => s.projects)
  const switchProject = useProjectStore(s => s.switchProject)
  const pushToast = useProjectStore(s => s.pushToast)
  const closeRemoteConnections = useUIStore(s => s.closeRemoteConnections)
  const creatingForProject = useUIStore(s => s.remoteConnectionsCreating)

  const [selectedId, setSelectedId] = useState<string | null>(
    creatingForProject ? NEW_SSH_CONNECTION_ID : null
  )
  const [form, setForm] = useState<SshConnectionForm>(emptyConnectionForm())
  const [editing, setEditing] = useState(false)
  const [search, setSearch] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [allProjects, setAllProjects] = useState(false)
  const [mode, setMode] = useState<SshConnectionMode>('server')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(true)
  /** Only a successful authentication of this exact configuration authorizes saving it. */
  const [verification, setVerification] = useState<{ key: string; fingerprint: string } | null>(null)
  const [aliveMap, setAliveMap] = useState<Record<string, boolean | null>>({})
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({})
  const [directInfos, setDirectInfos] = useState<Record<string, DirectAgentInfo | null>>({})
  const [agentDraftId, setAgentDraftId] = useState(() => crypto.randomUUID())
  const [roots, setRoots] = useState<SshWorkspaceRoot[]>([])
  const [statesByConnection, setStatesByConnection] = useState<Record<string, SshServerState[]>>({})
  const [detailLoading, setDetailLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [directDraft, setDirectDraft] = useState({ dirty: false, busy: false })
  const updateDirectDraft = useCallback((value: { dirty: boolean; busy: boolean }) => setDirectDraft(value), [])
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number } | null>(null)
  const navigationPending = useRef(false)
  const [importOpen, setImportOpen] = useState(false)
  const [error, setError] = useState('')
  const [busyRoot, setBusyRoot] = useState<string | null>(null)
  const [logView, setLogView] = useState<LogView | null>(null)
  const detailRequestRef = useRef(0)
  const statusRevisionRef = useRef<Record<string, number>>({})
  const statusRequestRef = useRef<Record<string, number>>({})
  const mountedRef = useRef(true)
  const testRequestRef = useRef(0)
  const testControllerRef = useRef<AbortController | null>(null)

  const invalidateVerification = () => {
    testRequestRef.current += 1
    testControllerRef.current?.abort()
    setVerification(null)
    setTesting(false)
  }

  const updateForm = (change: Partial<SshConnectionForm>) => {
    if (Object.keys(change).some(key => key !== 'name')) invalidateVerification()
    setForm(prev => ({ ...prev, ...change }))
  }

  const isNewAgent = selectedId === NEW_AGENT_CONNECTION_ID
  const isNew = selectedId === NEW_SSH_CONNECTION_ID || isNewAgent
  const selected = connections.find(item => item.id === selectedId) ?? null
  const selectedDirect = selected ? directInfos[selected.id] : null
  const standaloneAgent = Boolean(selected && selected.username === 'Agent' && selected.auth_kind === 'password' && (selected.agentEndpoint || selected.host_key_fingerprint === selectedDirect?.certificateFingerprint))
  const directEndpoint = selectedDirect && (selectedDirect.enabled || standaloneAgent) ? selectedDirect : selected?.agentEndpoint
  const directEnabled = selectedDirect ? selectedDirect.enabled : Boolean(selected?.agentEndpoint)
  const connectionModeLabel = directEnabled || standaloneAgent || selected?.agentEndpoint ? 'Server 端口直连'
    : selected && resolveSshConnectionMode(selected, getSshServerEnabled()) === 'ssh' ? 'SSH 直连（兼容模式）' : 'SSH + 远端服务'
  const serverStates = selected ? statesByConnection[selected.id] ?? [] : []
  const groupedProjects = useMemo(() => groupConnectionProjects(projects), [projects])
  const status = connectionStatus(selected ? aliveMap[selected.id] : null, serverStates, selected ? statusErrors[selected.id] : undefined)
  const statusReason = (selected ? statusErrors[selected.id] : '') || serverStates.find(state => state.reason)?.reason
  const filteredConnections = connections.filter(connection => {
    const summary = connectionStatus(aliveMap[connection.id], statesByConnection[connection.id] ?? [], statusErrors[connection.id])
    const info = directInfos[connection.id]
    return (!attentionOnly || summary.attention) && matchesConnection(info?.enabled ? { ...connection, agentEndpoint: info } : connection, groupedProjects.get(connection.id) ?? [], search)
  })
  const attentionCount = connections.filter(connection => connectionStatus(aliveMap[connection.id], statesByConnection[connection.id] ?? [], statusErrors[connection.id]).attention).length

  const refreshStatus = useCallback(async (id: string) => {
    const revision = statusRevisionRef.current[id] ?? 0
    const request = (statusRequestRef.current[id] ?? 0) + 1
    statusRequestRef.current[id] = request
    const [aliveResult, statesResult, directResult] = await Promise.allSettled([
      isSshConnectionAlive(id, true),
      listSshServerStates(id, true),
      directAgentApi.info(id),
    ])
    if (!mountedRef.current || statusRequestRef.current[id] !== request) return
    if (directResult.status === 'fulfilled') setDirectInfos(prev => ({ ...prev, [id]: directResult.value ?? null }))
    // A state event received during the snapshot is newer than its result.
    if ((statusRevisionRef.current[id] ?? 0) !== revision) return
    setAliveMap(prev => ({ ...prev, [id]: isSshBackgroundSuspended(id) ? false : aliveResult.status === 'fulfilled' ? aliveResult.value : null }))
    setStatusErrors(prev => ({ ...prev, [id]: aliveResult.status === 'rejected' ? String(aliveResult.reason) : statesResult.status === 'rejected' ? String(statesResult.reason) : directResult.status === 'rejected' ? String(directResult.reason) : '' }))
    if (statesResult.status === 'fulfilled') setStatesByConnection(prev => ({ ...prev, [id]: statesResult.value }))
  }, [])

  const refreshDetail = useCallback(async (id: string, includeStatus = true) => {
    const requestId = ++detailRequestRef.current
    setDetailLoading(true)
    const [nextRoots] = await Promise.all([
      listSshWorkspaceRoots(id),
      includeStatus ? refreshStatus(id) : Promise.resolve(),
    ])
    if (requestId !== detailRequestRef.current) return
    setRoots(nextRoots)
    setDetailLoading(false)
  }, [refreshStatus])

  // 初次打开：加载连接并默认选中第一个。
  useEffect(() => {
    void loadSshConnections().then(() => {
      const saved = useProjectStore.getState().sshConnections
      setSelectedId(prev => prev ?? saved[0]?.id ?? null)
    })
  }, [loadSshConnections])

  // 切换选中连接：填充表单并拉取详情。
  useEffect(() => {
    testRequestRef.current += 1
    testControllerRef.current?.abort()
    detailRequestRef.current += 1
    const conn =
      selectedId && selectedId !== NEW_SSH_CONNECTION_ID
        ? useProjectStore.getState().sshConnections.find(item => item.id === selectedId)
        : null
    setForm(conn ? formFromConnection(conn) : emptyConnectionForm())
    // 新连接统一使用 Server；旧连接仍按已存模式或旧设置解析，避免静默迁移。
    const nextMode = conn ? resolveSshConnectionMode(conn, getSshServerEnabled()) : 'server'
    setMode(nextMode)
    setAdvancedOpen(nextMode === 'ssh')
    setPassword('')
    setPassphrase('')
    setRemember(true)
    setVerification(null)
    setTesting(false)
    setError('')
    setAllProjects(false)
    setRoots([])
    if (conn) void refreshDetail(conn.id, false)
  }, [selectedId, refreshDetail])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      testRequestRef.current += 1
      testControllerRef.current?.abort()
      detailRequestRef.current += 1
    }
  }, [])

  // 连接列表变化时修正失效的选中项。
  useEffect(() => {
    if (!selectedId || selectedId === NEW_SSH_CONNECTION_ID || selectedId === NEW_AGENT_CONNECTION_ID) return
    if (!connections.some(item => item.id === selectedId)) {
      setEditing(false)
      setSelectedId(connections[0]?.id ?? null)
    }
  }, [connections, selectedId])

  // 列表里的在线状态点；连接列表变化后刷新一轮。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ids = connections.map(item => item.id)
      // Limit simultaneous native requests for large saved connection lists.
      for (let offset = 0; offset < ids.length && !cancelled; offset += 4) {
        await Promise.all(ids.slice(offset, offset + 4).map(refreshStatus))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connections, refreshStatus])

  useEffect(() => {
    const invalidate = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      statusRevisionRef.current[id] = (statusRevisionRef.current[id] ?? 0) + 1
      setAliveMap(prev => ({ ...prev, [id]: false }))
      setStatesByConnection(prev => ({ ...prev, [id]: [] }))
      setStatusErrors(prev => ({ ...prev, [id]: '' }))
      if (id === selectedId) {
        detailRequestRef.current += 1
        setRoots([])
        setDetailLoading(false)
      }
    }
    const refresh = () => {
      if (selectedId && selectedId !== NEW_SSH_CONNECTION_ID && selectedId !== NEW_AGENT_CONNECTION_ID && document.visibilityState !== 'hidden') void refreshDetail(selectedId)
    }
    const timer = setInterval(refresh, 5000)
    window.addEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
    window.addEventListener(SSH_CONNECTION_DISCONNECTED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
      window.removeEventListener(SSH_CONNECTION_DISCONNECTED_EVENT, refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [selectedId, refreshDetail])

  // 订阅代理状态事件，管理页与状态栏芯片看到同一份阶段模型。
  useEffect(() => {
    if (!hasBackend()) return
    let cancelled = false
    let unlisten: UnlistenFn | undefined
    void listen<unknown>('ssh-server-state', event => {
      const next = parseSshServerState(event.payload)
      if (!next || cancelled) return
      if (next.phase !== 'disconnected' && isSshBackgroundSuspended(next.connectionId)) return
      statusRevisionRef.current[next.connectionId] = (statusRevisionRef.current[next.connectionId] ?? 0) + 1
      setStatesByConnection(prev => {
        const current = prev[next.connectionId] ?? []
        const index = current.findIndex(item => item.rootUri === next.rootUri)
        if (index === -1) return { ...prev, [next.connectionId]: [...current, next] }
        const copy = [...current]
        copy[index] = next
        return { ...prev, [next.connectionId]: copy }
      })
      if (next.phase !== 'disconnected') setAliveMap(prev => ({ ...prev, [next.connectionId]: true }))
      else void refreshStatus(next.connectionId)
      setStatusErrors(prev => ({ ...prev, [next.connectionId]: '' }))
    }).then(stop => {
      if (cancelled) stop()
      else unlisten = stop
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [refreshStatus])

  const connectionProjects = selected ? groupedProjects.get(selected.id) ?? [] : []
  const visibleProjects = allProjects ? connectionProjects : connectionProjects.slice(0, 5)

  const verificationKey = JSON.stringify([
    selectedId, form.host.trim(), Number.parseInt(form.port, 10), form.username.trim(),
    form.authKind, form.privateKeyPath.trim(), mode, password, passphrase,
  ])
  const verified = verification?.key === verificationKey ? verification : null
  const fingerprintOverride = verified && verified.fingerprint !== selected?.host_key_fingerprint
    ? verified.fingerprint : null
  const effectiveFingerprint = verified?.fingerprint || selected?.host_key_fingerprint || null
  const authenticationChanged = selected && (
    form.authKind !== selected.auth_kind ||
    form.privateKeyPath.trim() !== (selected.private_key_path ?? '').trim()
  )
  const dirty = selected
    ? !formEqualsConnection(form, selected) ||
      mode !== resolveSshConnectionMode(selected, getSshServerEnabled())
    : true
  const requestNavigation = async (navigate: () => void) => {
    if (saving || directDraft.busy || navigationPending.current) return
    navigationPending.current = true
    try {
      const sshChanged = selected ? dirty : JSON.stringify(form) !== JSON.stringify(emptyConnectionForm()) || mode !== 'server'
      const hasChanges = ((editing || isNew) && (sshChanged || password || passphrase)) || directDraft.dirty
      if (hasChanges && !await confirmDialog({
        title: t('放弃连接修改'), message: t('离开当前连接将放弃尚未保存的修改。'),
        kind: 'warning', confirmLabel: t('放弃修改'), cancelLabel: t('继续编辑'),
      })) return
      if (!mountedRef.current) return
      invalidateVerification()
      setDirectDraft({ dirty: false, busy: false })
      if (selected) {
        setForm(formFromConnection(selected))
        setMode(resolveSshConnectionMode(selected, getSshServerEnabled()))
      }
      setPassword('')
      setPassphrase('')
      setActionMenu(null)
      navigate()
    } finally {
      navigationPending.current = false
    }
  }
  const alive = selected ? aliveMap[selected.id] ?? false : false

  const testConnection = async () => {
    if (testing) return
    const invalid = validateConnectionForm(form)
    if (invalid) {
      setError(t(invalid))
      return
    }
    const id = crypto.randomUUID()
    const secrets: SshSessionSecrets = {
      password: password || undefined,
      passphrase: passphrase || undefined,
    }
    if (form.authKind === 'password' && !secrets.password) {
      setError(t('请输入 SSH 密码以测试连接。'))
      return
    }
    setTesting(true)
    setVerification(null)
    setError('')
    const request = ++testRequestRef.current
    testControllerRef.current?.abort()
    const controller = new AbortController()
    testControllerRef.current = controller
    const isCurrent = () => request === testRequestRef.current
    try {
      const runtimeConfig = { ...runtimeConfigFromForm(form, id, secrets), mode }
      const probed = await probeSshHost(runtimeConfig)
      if (!isCurrent()) return
      const status = fingerprintStatus(selected?.host_key_fingerprint, probed)
      if (status !== 'match') {
        const accepted = await confirmDialog({
          title: status === 'new' ? t('确认 SSH 主机指纹') : t('主机指纹已变化'),
          message:
            status === 'new'
              ? t('首次连接 {target}，请确认主机指纹。', {
                  target: sshConnectionTarget({
                    username: form.username.trim() || 'user',
                    host: form.host.trim() || 'host',
                    port: Number.parseInt(form.port, 10) || 22,
                  }),
                })
              : t('远端主机指纹与已存档不一致，可能是远端重装系统，也可能存在中间人风险。'),
          detail: probed,
          kind: 'warning',
          confirmLabel: status === 'new' ? t('信任此主机') : t('接受新指纹'),
          cancelLabel: t('取消'),
          signal: controller.signal,
        })
        if (!isCurrent() || !accepted) return
      }
      await testSshConnection({
        ...runtimeConfig,
        hostKeyFingerprint: probed,
      })
      if (!isCurrent()) return
      setVerification({ key: verificationKey, fingerprint: probed })
      pushToast('success', t('SSH 连接成功'))
    } catch (reason) {
      if (isCurrent()) setError(String(reason))
    } finally {
      if (isCurrent()) setTesting(false)
    }
  }

  const saveConnection = async () => {
    if (saving) return
    const invalid = validateConnectionForm(form)
    if (invalid) {
      setError(t(invalid))
      return
    }
    if (selected && (targetChanged(form, selected) || authenticationChanged || password || passphrase) && !verified) {
      setError(t('主机目标已变化，请先「测试连接」确认新的主机指纹。'))
      return
    }
    if (!effectiveFingerprint || (isNew && !verified)) {
      setError(t('请先「测试连接」确认主机指纹后再保存。'))
      return
    }
    const modeChanged = Boolean(
      selected && mode !== resolveSshConnectionMode(selected, getSshServerEnabled())
    )
    const configChanged = Boolean(selected && (
      targetChanged(form, selected) || authenticationChanged || password || passphrase ||
      effectiveFingerprint !== selected.host_key_fingerprint
    ))
    const reconnectNeeded = (modeChanged || configChanged) && alive
    if (reconnectNeeded && selected) {
      const accepted = await confirmDialog({
        title: modeChanged ? t('更改兼容模式') : t('保存并重新连接'),
        message: modeChanged
          ? t('将断开并重新连接 {name}。当前终端可能被关闭；兼容模式不支持终端断线恢复。', {
              name: sshConnectionLabel(selected),
            })
          : t('将断开并重新连接 {name}，以应用新的连接配置。当前终端可能被关闭。', {
              name: sshConnectionLabel(selected),
            }),
        kind: 'warning',
        confirmLabel: t('保存并重新连接'),
        cancelLabel: t('取消'),
      })
      if (!accepted) return
    }
    setSaving(true)
    setError('')
    try {
      const base = selected ?? {
        id: crypto.randomUUID(),
        created_at: Date.now(),
      }
      const saved = connectionFromForm(form, base, effectiveFingerprint)
      if (reconnectNeeded && selected && modeChanged) {
        // 先保存其他字段并保留旧模式，再由切换逻辑写新模式并断开重连。
        await saveSshConnection({
          ...saved,
          mode: selected.mode ?? resolveSshConnectionMode(selected, getSshServerEnabled()),
        })
      } else {
        await saveSshConnection({ ...saved, mode })
      }
      // 新建连接同样要记住刚通过测试的凭据，否则创建项目时还会再次要求输入。
      if (!selected || configChanged) {
        if (selected) forgetSshSessionSecrets(selected.id)
        rememberSshSessionSecrets(saved.id, {
          password: password || undefined,
          passphrase: passphrase || undefined,
        })
      }
      if (remember && (password || passphrase)) {
        await saveSshSecrets(saved.id, { password, passphrase })
      } else if (!remember || configChanged) {
        // 取消勾选，或目标/认证已变化且没有新凭据：旧的加密凭据不再可信，直接清除。
        await deleteSavedSshSecrets(saved.id)
      }
      if (reconnectNeeded && selected) {
        if (modeChanged) await switchSshConnectionMode(selected.id, mode)
        else await reconnectSshConnection(selected.id)
      }
      pushToast('success', t('已保存 SSH 连接'))
      setVerification(null)
      setPassword('')
      setPassphrase('')
      if (isNew && creatingForProject) {
        closeRemoteConnections()
        return
      }
      setSelectedId(base.id)
      setEditing(false)
      if (selected) await refreshDetail(selected.id)
    } catch (reason) {
      setError(String(reason))
      if (reconnectNeeded) {
        pushToast('error', t('切换连接模式失败: {error}', { error: String(reason) }))
      }
    } finally {
      setSaving(false)
    }
  }

  const removeConnection = async () => {
    if (!selected) return
    const refs = projects.filter(
      project =>
        project.connection_id === selected.id || sshConnectionIdFromUri(project.path) === selected.id
    )
    if (refs.length > 0) {
      setError(
        t('该连接仍被 {count} 个远程项目使用（{names}），请先在项目管理中删除或改绑这些项目。', {
          count: refs.length,
          names: refs.map(project => project.name).join('、'),
        })
      )
      return
    }
    const accepted = await confirmDialog({
      title: t('删除 SSH 连接'),
      message: t('删除连接 {label}？此操作不可撤销。', { label: sshConnectionLabel(selected) }),
      kind: 'warning',
      confirmLabel: t('删除'),
      cancelLabel: t('取消'),
    })
    if (!accepted) return
    try {
      await disconnectSshSession(selected.id).catch(() => {})
      await deleteSshConnection(selected.id)
      pushToast('success', t('已删除 SSH 连接'))
      setSelectedId(null)
    } catch (reason) {
      setError(String(reason))
    }
  }

  const disconnectConnection = async () => {
    if (!selected) return
    const accepted = await confirmDialog({
      title: t(directEnabled ? '断开 Server 直连' : '断开 SSH 连接'),
      message: t(
        directEnabled ? '断开 {label} 的 Server 连接？打开的项目会失去连接，重新打开项目时可以重连。' : '断开 {label}？将结束此连接的远端终端及其中运行的任务，打开的远程项目会失去连接。重新打开项目时可以重连（密码需重新输入）。',
        { label: sshConnectionLabel(selected) }
      ),
      kind: 'warning',
      confirmLabel: t('断开'),
      cancelLabel: t('取消'),
    })
    if (!accepted) return
    try {
      await disconnectSshSession(selected.id)
      pushToast('success', t('已断开连接'))
      await refreshDetail(selected.id)
    } catch (reason) {
      setError(String(reason))
    }
  }

  const revokeTrust = async (rootUri: string) => {
    const accepted = await confirmDialog({
      title: t('撤销工作区信任'),
      message: t('撤销后该远程项目回到受限模式，写文件与运行命令前需要重新信任。'),
      kind: 'warning',
      confirmLabel: t('撤销信任'),
      cancelLabel: t('取消'),
    })
    if (!accepted) return
    try {
      const matching = projects.filter(project =>
        normalizeProjectPath(project.path) === normalizeProjectPath(rootUri)
      )
      for (const project of matching) restrictProject(project)
      if (matching.length === 0) restrictProject({ id: rootUri, path: rootUri })
      await safeInvoke('撤销 SSH 工作区信任', 'ssh_set_workspace_trust', {
        rootUri,
        trusted: false,
      })
      pushToast('success', t('已撤销信任'))
      if (selectedId) await refreshDetail(selectedId)
    } catch (reason) {
      pushToast('error', t('撤销信任失败: {error}', { error: String(reason) }))
    }
  }

  const restartServer = async (rootUri: string, direct: boolean, agent = false) => {
    if (busyRoot) return
    setBusyRoot(rootUri)
    try {
      const accepted = agent || await confirmSshServerRestart(rootUri, t)
      if (!accepted) return
      const value = await safeInvoke<unknown>('重启远端服务', 'ssh_server_restart', { rootUri })
      const next = parseSshServerState(value)
      if (next && sshServerIsDirect(next)) {
        pushToast('warn', t('仍使用 SSH 直连'), next.reason ?? undefined)
      } else if (next?.phase === 'readyServer') {
        pushToast('success', t(agent ? '已重新连接 Server' : direct ? '已切换到远端服务' : '已重启远端服务'))
      } else {
        pushToast('info', t('正在部署远端服务…'))
      }
    } catch (reason) {
      if (!isAgentCommandUnavailable(reason)) {
        pushToast(
          'error',
          t(agent ? '重新连接 Server 失败: {error}' : direct ? '切换到远端服务失败: {error}' : '重启远端服务失败: {error}', {
            error: String(reason),
          })
        )
      }
    } finally {
      setBusyRoot(null)
    }
  }

  const showLogs = async (rootUri: string) => {
    setLogView({ rootUri, text: '', loading: true })
    try {
      const result = await safeInvoke<{ text: string }>('读取远端服务日志', 'ssh_server_logs', {
        rootUri,
      })
      setLogView({ rootUri, text: result.text, loading: false })
    } catch (reason) {
      setLogView(null)
      if (!isAgentCommandUnavailable(reason)) {
        pushToast('error', t('读取远端服务日志失败: {error}', { error: String(reason) }))
      }
    }
  }

  const openProject = async (project: Project) => {
    closeRemoteConnections()
    await switchProject(project)
  }

  const leaveEditor = async () => {
    if (!selected) return
    await requestNavigation(() => {
    setForm(formFromConnection(selected))
    const savedMode = resolveSshConnectionMode(selected, getSshServerEnabled())
    setMode(savedMode)
    setAdvancedOpen(savedMode === 'ssh')
    setPassword('')
    setPassphrase('')
    setError('')
    setEditing(false)
    })
  }

  const choosePrivateKey = async () => {
    const selectedPath = await open({
      directory: false,
      multiple: false,
      title: '选择 SSH 私钥',
    })
    if (typeof selectedPath === 'string') {
      updateForm({ privateKeyPath: selectedPath })
    }
  }

  const remoteShort = (rootUri: string) => rootUri.replace(/^ssh:\/\/[^/]+/, '') || '/'

  const renderForm = () => (
    <fieldset disabled={saving} className="min-w-0 space-y-5 border-0 p-0">
      <fieldset className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-3 @md:grid-cols-[minmax(0,1fr)_7rem]">
        <legend className={`${sectionTitleClass} mb-3`}>{t('基本信息')}</legend>
        <label className={`col-span-full ${labelClass}`}>
          {t('连接名称')}
          <input
            value={form.name}
            onChange={event => updateForm({ name: event.target.value })}
            placeholder={t('默认使用主机名')}
            className={`${fieldClass} mt-1`}
          />
        </label>
        <label className={labelClass}>
          {t('主机')}
          <input
            value={form.host}
            onChange={event => updateForm({ host: event.target.value })}
            placeholder="192.168.1.10"
            className={`${fieldClass} mt-1`}
          />
        </label>
        <label className={labelClass}>
          {t('端口')}
          <input
            value={form.port}
            onChange={event => updateForm({ port: event.target.value })}
            inputMode="numeric"
            className={`${fieldClass} mt-1`}
          />
        </label>
        <label className={`col-span-full ${labelClass}`}>
          {t('用户名')}
          <input
            value={form.username}
            onChange={event => updateForm({ username: event.target.value })}
            placeholder="root"
            className={`${fieldClass} mt-1`}
          />
        </label>
      </fieldset>
      <fieldset className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-3 border-t border-dialog-separator pt-4 @lg:grid-cols-2">
        <legend className={`${sectionTitleClass} pr-3`}>{t('身份认证')}</legend>
        <label className={`col-span-full ${labelClass}`}>
          {t('认证方式')}
          <select
            value={form.authKind}
            onChange={event =>
              updateForm({
                authKind: event.target.value as SshConnectionForm['authKind'],
              })
            }
            className={`${fieldClass} mt-1`}
          >
            <option value="privateKey">{t('私钥（推荐，WSL 无需密码）')}</option>
            <option value="password">{t('密码')}</option>
          </select>
        </label>
        {form.authKind === 'privateKey' ? (
          <label className={`col-span-full ${labelClass}`}>
            {t('私钥文件（可选）')}
            <div className="mt-1 flex gap-2">
              <input
                value={form.privateKeyPath}
                onChange={event =>
                  updateForm({ privateKeyPath: event.target.value })
                }
                placeholder={t('留空则使用 ~/.ssh/id_ed25519 等默认密钥')}
                className={`${fieldClass} font-mono`}
              />
              <button
                type="button"
                onClick={() => void choosePrivateKey()}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-dialog-border px-2.5 text-ui text-fg hover:bg-bg-hover"
              >
                <KeyRound size={13} />
                {t('选择')}
              </button>
            </div>
          </label>
        ) : null}
        <label className={labelClass}>
          {remember
            ? t('密码（加密保存在本机）')
            : isNew ? t('密码（测试连接用，不会保存）') : t('密码（仅测试连接用，不会保存）')}
          <input
            type="password"
            value={password}
            onChange={event => { invalidateVerification(); setPassword(event.target.value) }}
            className={`${fieldClass} mt-1`}
          />
        </label>
        <label className={`col-span-full flex items-center gap-2 ${labelClass}`}>
          <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
          {t('记住凭据（加密保存在本机，下次无需输入）')}
        </label>
        {form.authKind === 'privateKey' ? (
          <label className={labelClass}>
            {remember ? t('私钥口令（如有，加密保存在本机）') : t('私钥口令（如有，仅本次会话）')}
            <input
              type="password"
              value={passphrase}
              onChange={event => { invalidateVerification(); setPassphrase(event.target.value) }}
              className={`${fieldClass} mt-1`}
            />
          </label>
        ) : null}
        {selected ? (
          <div className={`col-span-full ${labelClass}`}>
            {t('主机指纹')}
            <div className={valueBoxClass}>
              <Globe size={14} className="flex-shrink-0 text-fg-dim" />
              <span className="min-w-0 flex-1 truncate">
                {effectiveFingerprint ?? t('尚未确认（保存前需先测试连接）')}
              </span>
              {fingerprintOverride ? (
                <span className="flex-shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-ui-sm text-warn">
                  {t('已确认新指纹')}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </fieldset>
      <div className="space-y-3 border-t border-dialog-separator pt-5">
        <p className={helpClass}>
          {t(
            '远程开发通过 SSH 连接，信任项目后自动部署远端服务，提供文件监听、内容搜索与持久终端。'
          )}
        </p>
        <div className="rounded border border-dialog-border">
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="ssh-connection-advanced"
            onClick={() => setAdvancedOpen(open => !open)}
            className="flex w-full items-center gap-1.5 rounded px-2.5 py-2 text-ui text-fg hover:bg-bg-hover"
          >
            {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t('高级')}
            {mode === 'ssh' ? (
              <span className="ml-auto text-ui-xs text-warn">{t('兼容模式已启用')}</span>
            ) : null}
          </button>
          {advancedOpen ? (
            <div
              id="ssh-connection-advanced"
              className="space-y-2 border-t border-dialog-separator px-3 py-2.5"
            >
              <label className="flex items-start gap-2 text-ui text-fg">
                <span className="inline-flex h-[var(--ui-line-height)] flex-shrink-0 items-center">
                  <input
                    type="checkbox"
                    checked={mode === 'ssh'}
                    onChange={event => { invalidateVerification(); setMode(event.target.checked ? 'ssh' : 'server') }}
                    className="m-0 h-3.5 w-3.5 accent-accent"
                  />
                </span>
                <span className="min-w-0">{t('兼容模式（SSH 直连）')}</span>
              </label>
              <p className={helpClass}>
                {t(
                  '仅用于无法运行远端服务的主机。不部署服务，文件树不会自动刷新，终端不支持断线恢复。'
                )}
              </p>
              <p className={helpClass}>
                {t('兼容模式按连接保存；修改已有连接后需保存并重新连接。')}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </fieldset>
  )

  return (
    <>
      <ModalOverlay onDismiss={() => void requestNavigation(closeRemoteConnections)} zIndex="z-[130]">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="remote-connections-title"
          className="ui-font-scaled modal-content-enter relative flex h-[80vh] w-[94vw] max-w-[1100px] max-h-[85vh] flex-col overflow-hidden rounded-lg border border-dialog-border bg-dialog text-fg shadow-elevation-3"
          onPointerDown={event => event.stopPropagation()}
        >
          <div className="flex min-h-12 flex-shrink-0 items-center justify-between gap-3 border-b border-dialog-separator bg-dialog-chrome px-4 py-2">
            <div className="flex items-center gap-2 text-ui-lg font-semibold text-fg">
              <Globe size={16} className="text-fg-muted" />
              <h2 id="remote-connections-title">{t('远程连接')}</h2>
              <span className="hidden text-ui-sm font-normal text-fg-muted sm:inline">
                {t('连接 · 项目 · 远端服务')}
              </span>
            </div>
            <Tooltip label={t('关闭')} side="left">
              <button
                type="button"
                disabled={saving || directDraft.busy}
                  onClick={() => void requestNavigation(closeRemoteConnections)}
                className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
                aria-label={t('关闭')}
              >
                <X size={18} />
              </button>
            </Tooltip>
          </div>

          <div className="flex min-h-0 flex-1">
            <aside className="flex w-36 flex-shrink-0 flex-col border-r border-dialog-separator bg-dialog-sidebar sm:w-60">
              <div className="space-y-2 p-2">
                <label className="flex items-center gap-1 rounded border border-dialog-border bg-dialog-input px-2">
                  <Search size={13} className="shrink-0 text-fg-dim" aria-hidden />
                  <input className="min-w-0 w-full bg-transparent py-1.5 text-ui-sm text-fg outline-none" aria-label={t('搜索连接或项目')} placeholder={t('搜索连接或项目')} value={search} onChange={event => setSearch(event.target.value)} />
                </label>
                <button type="button" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(value => !value)} className={`w-full rounded px-2 py-1 text-left text-ui-sm ${attentionOnly ? 'bg-dialog-active text-warn' : 'text-fg-muted hover:bg-bg-hover'}`}>
                  {t('需要处理')} · {attentionCount}
                </button>
                <button
                  type="button"
                  disabled={saving || directDraft.busy}
                  onClick={() => void requestNavigation(() => { setEditing(false); setSelectedId(NEW_SSH_CONNECTION_ID) })}
                  className={`flex w-full items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-ui transition-colors ${
                    selectedId === NEW_SSH_CONNECTION_ID
                      ? 'border-brand/60 bg-brand/10 text-brand'
                      : 'border-dialog-border text-fg hover:bg-bg-hover'
                  }`}
                >
                  <Plus size={14} />
                  {t('新建连接')}
                </button>
                <button
                  type="button"
                  disabled={saving || directDraft.busy}
                  onClick={() => void requestNavigation(() => { setAgentDraftId(crypto.randomUUID()); setEditing(false); setSelectedId(NEW_AGENT_CONNECTION_ID) })}
                  className={`flex w-full items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-ui ${isNewAgent ? 'border-brand/60 bg-brand/10 text-brand' : 'border-dialog-border text-fg hover:bg-bg-hover'}`}
                >
                  <Plus size={14} />
                  {t('新建 Server 直连')}
                </button>
                <button
                  type="button"
                  disabled={saving || directDraft.busy}
                  onClick={() => void requestNavigation(() => setImportOpen(true))}
                  className="flex w-full items-center justify-center gap-1.5 rounded px-2 py-1.5 text-ui-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <Download size={14} />
                  {t('导入已有连接')}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {filteredConnections.length === 0 && <p className="px-3 py-4 text-ui-sm text-fg-muted">{t(connections.length ? '没有匹配的连接' : '暂无连接')}</p>}
                {filteredConnections.map(connection => {
                  const active = connection.id === selectedId
                  const summary = connectionStatus(aliveMap[connection.id], statesByConnection[connection.id] ?? [], statusErrors[connection.id])
                  const info = directInfos[connection.id]
                  const standalone = connection.username === 'Agent' && connection.auth_kind === 'password' && connection.host_key_fingerprint === info?.certificateFingerprint
                  const endpoint = info && (info.enabled || standalone) ? info : connection.agentEndpoint
                  return (
                    <button
                      key={connection.id}
                      aria-current={active ? 'true' : undefined}
                      type="button"
                      disabled={saving || directDraft.busy}
                  onClick={() => { if (connection.id !== selectedId) void requestNavigation(() => { setEditing(false); setSelectedId(connection.id) }) }}
                      className={`flex w-full flex-col gap-0.5 border-l-2 px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-brand bg-dialog-active text-fg'
                          : 'border-transparent text-dialog-label hover:bg-bg-hover hover:text-fg'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-ui">
                        <span
                          aria-hidden
                          className={`h-[6px] w-[6px] flex-shrink-0 rounded-full ${
                            summary.tone === 'ok' ? 'bg-ok' : summary.tone === 'warn' ? 'bg-warn' : 'bg-fg-dim'
                          }`}
                        />
                        <span className="min-w-0 truncate">{connection.name}</span>
                      </span>
                      <span className="min-w-0 truncate pl-[13px] font-mono text-ui-sm text-fg-dim">
                        {endpoint ? `${endpoint.host}:${endpoint.port} · TLS` : sshConnectionTarget(connection)}
                      </span>
                      <span className={`pl-[13px] text-ui-sm ${summary.tone === 'warn' ? 'text-warn' : 'text-fg-muted'}`}>{t(summary.label)} · {t('{count} 个项目', { count: groupedProjects.get(connection.id)?.length ?? 0 })}</span>
                    </button>
                  )
                })}
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <section className="@container min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {isNew || selected ? (
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Server size={15} className="flex-shrink-0 text-fg-muted" />
                        <h3 className="min-w-0 truncate text-ui-lg font-semibold text-fg">
                          {isNewAgent ? t('新建 Server 直连') : isNew ? t('新建连接') : selected!.name}
                        </h3>
                        {!isNew && (
                          <span
                            className={`flex-shrink-0 rounded px-1.5 py-0.5 text-ui-sm ${
                              status.tone === 'ok' ? 'bg-ok/10 text-ok' : status.tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-dialog-active text-fg-muted'
                            }`}
                          >
                            {t(status.label)}
                          </span>
                        )}
                        {directEnabled && <span className="rounded bg-dialog-active px-1.5 py-0.5 text-ui-sm font-normal text-fg-muted">{t('Server 端口直连')}</span>}
                      </div>
                      {!isNew && selected && (
                        <div className="flex flex-wrap items-center gap-2">
                          {!editing && <button type="button" onClick={() => setEditing(true)} className={`${primaryButtonClass} inline-flex items-center gap-1`}><Pencil size={13} />{t('编辑连接')}</button>}
                          <button type="button" disabled={detailLoading} onClick={() => void refreshDetail(selected.id)} className={secondaryButtonClass}>{t('刷新状态')}</button>
                          <Tooltip label={t('更多连接操作')} side="left">
                            <button
                              type="button"
                              aria-haspopup="menu"
                              aria-expanded={Boolean(actionMenu)}
                              onClick={event => { event.currentTarget.focus(); const rect = event.currentTarget.getBoundingClientRect(); setActionMenu({ x: rect.right - 180, y: rect.bottom + 4 }) }}
                              className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
                              aria-label={t('更多连接操作')}
                            >
                              <MoreHorizontal size={16} />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>

                    {error && !isNew && !editing && <p role="alert" className="whitespace-pre-wrap rounded border border-danger/30 bg-danger/10 px-3 py-2 text-ui text-danger">{error}</p>}

                    {!isNew && selected && !editing && (
                      <div className="space-y-2 rounded border border-dialog-border bg-dialog-sidebar p-3">
                        <p className="break-all font-mono text-ui-sm text-fg">{directEndpoint ? `${directEndpoint.host}:${directEndpoint.port}` : sshConnectionTarget(selected)}</p>
                        <p className={helpClass}>{t(connectionModeLabel)}</p>
                        <p className={helpClass}>{t('选择下方项目以打开或重新连接；需要认证时会提示输入凭据。')}</p>
                        {statusReason && <p role="status" className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-ui-sm text-warn">{statusReason}</p>}
                      </div>
                    )}

                    {!isNew && !editing && selected && selectedDirect?.enabled && <details className="rounded border border-dialog-border p-3">
                      <summary className="cursor-pointer text-ui font-medium text-fg">{t('启动 Server 与开机自启')}</summary>
                      <div className="mt-3"><DirectServerRecoveryPanel key={selected.id} connectionId={selected.id} info={selectedDirect} connections={connections} onStarted={() => refreshDetail(selected.id)} onUpdated={info => setDirectInfos(prev => ({ ...prev, [selected.id]: info }))} /></div>
                    </details>}
                    {!isNew && !editing && selected && selectedDirect?.enabled && <DirectSshFallback connection={selected} info={selectedDirect} onConfigure={() => { setSelectedId(NEW_SSH_CONNECTION_ID); setEditing(true) }} onSwitched={async info => {
                      setDirectInfos(prev => ({ ...prev, [selected.id]: info }))
                      await loadSshConnections()
                      await reconnectSshConnection(selected.id)
                      await refreshDetail(selected.id)
                    }} />}
                    {(isNew || editing) && (isNewAgent ? <DirectAgentConnectionPanel
                      onDraftStateChange={updateDirectDraft}
                      key={agentDraftId}
                      connectionId={agentDraftId}
                      defaultHost=""
                      standalone
                      onUpdated={async info => {
                        const now = Date.now()
                        try {
                          await saveSshConnection({ id: agentDraftId, name: info.host, host: info.host, port: 22, username: 'Agent', auth_kind: 'password', host_key_fingerprint: info.certificateFingerprint, mode: 'server', created_at: now, updated_at: now })
                        } catch {
                          throw new Error('[direct:record] Server connection row could not be saved')
                        }
                        setDirectInfos(prev => ({ ...prev, [agentDraftId]: info }))
                        pushToast('success', t('已保存 Server 直连'))
                        setEditing(false)
                        setSelectedId(agentDraftId)
                        if (creatingForProject) closeRemoteConnections()
                      }}
                    /> : standaloneAgent ? <p className={helpClass}>{t('此连接仅配置 Server 直连；如需 SSH，请单独新建 SSH 连接。')}</p> : directEnabled ? <details className="rounded border border-dialog-border p-3">
                      <summary className="cursor-pointer text-ui font-medium text-fg">{t('SSH 安装与兼容配置')}</summary>
                      <div className="mt-3">{renderForm()}</div>
                    </details> : <div>{renderForm()}</div>)}

                    {!isNew && selected && (
                      <>
                        {editing && <DirectAgentConnectionPanel
                          onDraftStateChange={updateDirectDraft}
                          key={selected.id}
                          connectionId={selected.id}
                          defaultHost={selected.host}
                          standalone={standaloneAgent}
                          onUpdated={async info => {
                            // A standalone row carries the accepted TLS identity as its
                            // compatibility fingerprint. Keep that marker after re-pairing.
                            if (standaloneAgent) {
                              try {
                                await saveSshConnection({ ...selected, host: info.host, host_key_fingerprint: info.certificateFingerprint, updated_at: Date.now() })
                              } catch {
                                throw new Error('[direct:record] Server connection row could not be saved')
                              }
                            } else {
                              await loadSshConnections()
                            }
                            setDirectInfos(prev => ({ ...prev, [selected.id]: info }))
                            void refreshDetail(selected.id)
                          }}
                        />}
                        {!editing && <>
                        <div>
                          <p className={`${sectionTitleClass} mb-2`}>
                            {t(allProjects ? '远程项目' : '最近项目')}
                            <span className="ml-1 text-ui-sm font-normal text-fg-dim">
                              {connectionProjects.length}
                            </span>
                            <button type="button" className="ml-auto rounded px-2 py-1 text-ui-sm font-normal text-fg-muted hover:bg-bg-hover" onClick={() => { closeRemoteConnections(); useUIStore.getState().openCreateProjectForConnection(selected.id) }}>{t('添加项目')}</button>
                          </p>
                          {connectionProjects.length === 0 ? (
                            <p className={helpClass}>{t('暂无使用此连接的远程项目。')}</p>
                          ) : (
                            <ul className="overflow-hidden rounded border border-dialog-border">
                              {visibleProjects.map(project => (
                                <li
                                  key={project.id}
                                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-dialog-separator px-3 py-2 last:border-b-0 @lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.5fr)_auto]"
                                >
                                  <FolderOpen size={13} className="flex-shrink-0 text-fg-dim" />
                                  <span className="col-start-2 row-start-1 min-w-0 text-ui text-fg [overflow-wrap:anywhere]">
                                    {project.name}
                                  </span>
                                  <Tooltip label={sshProjectDisplayPath(project, selected, connections)} side="top" wrapperClassName="col-start-2 row-start-2 min-w-0 @lg:col-start-3 @lg:row-start-1"><span className="block min-w-0 truncate font-mono text-ui-sm text-fg-muted">{sshProjectDisplayPath(project, selected, connections)}</span></Tooltip>
                                  <button
                                    type="button"
                                    onClick={() => void openProject(project)}
                                    className="col-start-3 row-start-1 rounded px-2 py-0.5 text-ui-sm text-accent hover:bg-accent/10 @lg:col-start-4"
                                  >
                                    {t('打开')}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          {connectionProjects.length > 5 && <button type="button" aria-expanded={allProjects} onClick={() => setAllProjects(value => !value)} className="mt-2 rounded px-2 py-1 text-ui-sm text-accent hover:bg-bg-hover">{t(allProjects ? '收起项目' : '查看全部项目')}</button>}
                        </div>

                        <div>
                          <p className={`${sectionTitleClass} mb-2`}>{t('信任与项目根')}</p>
                          {detailLoading ? (
                            <p className={helpClass}>{t('正在读取…')}</p>
                          ) : roots.length === 0 ? (
                            <p className={helpClass}>
                              {t('当前会话没有已注册的项目根。重新打开远程项目后会登记在这里。')}
                            </p>
                          ) : (
                            <ul className="overflow-hidden rounded border border-dialog-border">
                              {roots.map(root => (
                                <li
                                  key={root.rootUri}
                                  className="flex flex-wrap items-center gap-2 border-b border-dialog-separator px-3 py-2 last:border-b-0"
                                >
                                  {root.trusted ? (
                                    <ShieldCheck size={13} className="flex-shrink-0 text-accent" />
                                  ) : (
                                    <ShieldOff size={13} className="flex-shrink-0 text-warn" />
                                  )}
                                  <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-fg">
                                    {remoteShort(root.rootUri)}
                                  </span>
                                  <span
                                    className={`flex-shrink-0 rounded px-1.5 py-0.5 text-ui-sm ${
                                      root.trusted
                                        ? 'bg-accent/15 text-accent'
                                        : 'bg-warn/15 text-warn'
                                    }`}
                                  >
                                    {root.trusted ? t('已信任') : t('未信任')}
                                  </span>
                                  {root.trusted && (
                                    <button
                                      type="button"
                                      onClick={() => void revokeTrust(root.rootUri)}
                                      className="flex-shrink-0 rounded px-2 py-0.5 text-ui-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
                                    >
                                      {t('撤销信任')}
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <div>
                          <div className={`${sectionTitleClass} mb-2`}>
                            {t('远端服务模式')}
                            <Tooltip
                              label={t(
                                '远程开发默认使用远端服务，通过 SSH 提供文件树自动刷新、内容搜索与持久终端，不开放公网端口。服务不可用时可重试、查看日志或在设置中配置离线安装包。无法运行服务的主机可在「高级」中启用兼容模式。'
                              )}
                              side="top"
                            >
                              <button
                                type="button"
                                className="rounded p-0.5 text-fg-dim hover:text-fg"
                                aria-label={t('关于远端服务')}
                              >
                                <CircleHelp size={13} aria-hidden />
                              </button>
                            </Tooltip>
                            <button
                              type="button"
                              onClick={() => {
                                closeRemoteConnections()
                                useUIStore.getState().requestSettings('ssh.server')
                              }}
                              className="ml-auto rounded px-2 py-1 text-ui-xs font-normal text-fg-muted hover:bg-bg-hover hover:text-fg"
                            >
                              {t('服务安装设置')}
                            </button>
                          </div>
                          {detailLoading ? (
                            <p className={helpClass}>{t('正在读取…')}</p>
                          ) : serverStates.length === 0 ? (
                            <p className={helpClass}>
                              {t('当前会话没有可查询的项目。重新打开远程项目后会显示服务状态。')}
                            </p>
                          ) : (
                            <ul className="overflow-hidden rounded border border-dialog-border">
                              {serverStates.map(state => (
                                <li
                                  key={state.rootUri}
                                  className="flex flex-wrap items-center gap-2 border-b border-dialog-separator px-3 py-2 last:border-b-0"
                                >
                                  <FileText size={13} className="flex-shrink-0 text-fg-dim" />
                                  <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-fg">
                                    {remoteShort(state.rootUri)}
                                  </span>
                                  <span
                                    className={`flex-shrink-0 text-ui-sm ${
                                      state.phase === 'readyServer'
                                        ? 'text-ok'
                                        : 'text-fg-muted'
                                    }`}
                                  >
                                    {t(directEnabled ? 'Server 端口直连' : sshServerModeKey(state))}
                                  </span>
                                  {state.version && <span className="font-mono text-ui-sm text-fg-muted">v{state.version}</span>}
                                  {directEnabled ? <span className="flex-shrink-0 rounded bg-dialog-active px-1.5 py-0.5 text-ui-sm text-fg-muted">TLS</span> : sshServerTransportKey(state.transport) ? (
                                    <Tooltip
                                      label={t(transportTooltipKey(state.transport) ?? '未知')}
                                      side="top"
                                    >
                                      <span className="flex-shrink-0 rounded bg-dialog-active px-1.5 py-0.5 text-ui-sm text-fg-muted">
                                        {t(sshServerTransportKey(state.transport)!)}
                                      </span>
                                    </Tooltip>
                                  ) : null}
                                  {state.reason ? (
                                    <Tooltip label={state.reason} side="left">
                                      <span className="flex-shrink-0 text-ui-sm text-warn">
                                        {t('原因')}
                                      </span>
                                    </Tooltip>
                                  ) : null}
                                  {/* 兼容模式没有远端服务；在上方「高级」里关闭后保存并重连。 */}
                                  {state.connectionMode === 'ssh' ? null : (
                                    <>
                                      <Tooltip
                                        label={t(
                                          sshServerUsesGateway(state) || directEnabled ? '重新连接 Server' : sshServerIsDirect(state)
                                            ? '切换到远端服务'
                                            : '重启远端服务'
                                        )}
                                        side="top"
                                      >
                                        <button
                                          type="button"
                                          disabled={
                                            busyRoot === state.rootUri ||
                                            (sshServerIsDirect(state) &&
                                              !!sshServerSwitchBlocker(state))
                                          }
                                          onClick={() =>
                                            void restartServer(
                                              state.rootUri,
                                              sshServerIsDirect(state),
                                              sshServerUsesGateway(state) || directEnabled
                                            )
                                          }
                                          className="flex-shrink-0 rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                                          aria-label={t(
                                            sshServerUsesGateway(state) || directEnabled ? '重新连接 Server' : sshServerIsDirect(state)
                                              ? '切换到远端服务'
                                              : '重启远端服务'
                                          )}
                                        >
                                          <RefreshCw size={12} />
                                        </button>
                                      </Tooltip>
                                      <Tooltip label={t('查看远端服务日志')} side="left">
                                        <button
                                          type="button"
                                          onClick={() => void showLogs(state.rootUri)}
                                          className="flex-shrink-0 rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
                                          aria-label={t('查看远端服务日志')}
                                        >
                                          <ScrollText size={12} />
                                        </button>
                                      </Tooltip>
                                    </>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        </>}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <Server size={28} className="text-fg-dim" />
                    <p className={helpClass}>
                      {t('还没有 SSH 连接。新建一个连接，或通过「打开 SSH 项目」创建。')}
                    </p>
                    <button
                      type="button"
                      onClick={() => setSelectedId(NEW_SSH_CONNECTION_ID)}
                      className={primaryButtonClass}
                    >
                      {t('新建连接')}
                    </button>
                  </div>
                )}
              </section>
              {(isNew || editing) && (isNew || selected) && (
                <footer className="flex flex-shrink-0 flex-col gap-2 border-t border-dialog-separator bg-dialog-chrome px-5 py-3">
                  {error && <p role="alert" className="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-danger/30 bg-danger/10 px-2.5 py-2 text-ui text-danger">{error}</p>}
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {!isNew && <button type="button" disabled={testing || saving} onClick={() => void leaveEditor()} className={`${secondaryButtonClass} mr-auto`}>{t('返回概览')}</button>}
                    {!isNewAgent && !standaloneAgent && <>
                    <button
                      type="button"
                      disabled={testing || saving}
                      onClick={() => void testConnection()}
                      className={secondaryButtonClass}
                    >
                      {testing ? t('正在连接…') : t(directEnabled ? '测试 SSH 配置' : '测试连接')}
                    </button>
                    <button
                      type="button"
                      disabled={saving || testing || (selected ? !dirty && !verified : false)}
                      onClick={() => void saveConnection()}
                      className={primaryButtonClass}
                    >
                      {saving ? t('正在保存…') : t(directEnabled ? '保存 SSH 配置' : '保存')}
                    </button>
                    </>}
                  </div>
                </footer>
              )}
            </div>
          </div>
        </div>
      </ModalOverlay>
      {actionMenu && selected && <ContextMenu x={actionMenu.x} y={actionMenu.y} zIndex="z-[135]" onClose={() => setActionMenu(null)} items={[
        ...(alive ? [{ label: t('断开连接'), action: () => requestNavigation(() => { void disconnectConnection() }) }] : []),
        { label: t('删除连接'), danger: true, separatorBefore: alive, action: () => requestNavigation(() => { void removeConnection() }) },
      ]} />}

      {importOpen && (
        <SshImportDialog onClose={() => setImportOpen(false)} onImported={id => { setEditing(false); setSelectedId(id) }} />
      )}

      {logView && (
        <ModalOverlay onDismiss={() => setLogView(null)} zIndex="z-[135]">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-connections-log-title"
            className="modal-content-enter relative flex max-h-[min(70vh,520px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-dialog-border bg-dialog text-fg shadow-elevation-3"
            onPointerDown={event => event.stopPropagation()}
          >
            <header className="flex h-11 flex-shrink-0 items-center justify-between gap-3 border-b border-dialog-separator bg-dialog-chrome px-4">
              <h2
                id="remote-connections-log-title"
                className="min-w-0 truncate font-mono text-ui text-fg"
              >
                {remoteShort(logView.rootUri)}
              </h2>
              <div className="flex items-center gap-1">
                <Tooltip label={t('刷新')} side="bottom">
                  <button
                    type="button"
                    aria-label={t('刷新')}
                    className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
                    onClick={() => void showLogs(logView.rootUri)}
                  >
                    <RefreshCw size={16} />
                  </button>
                </Tooltip>
                <Tooltip label={t('关闭')} side="bottom">
                  <button
                    type="button"
                    aria-label={t('关闭')}
                    className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
                    onClick={() => setLogView(null)}
                  >
                    <X size={16} />
                  </button>
                </Tooltip>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              <pre className="whitespace-pre-wrap break-words rounded border border-dialog-border bg-dialog-input p-3 font-mono text-ui-sm text-fg">
                {logView.loading ? t('读取日志中…') : logView.text || t('没有日志')}
              </pre>
            </div>
          </section>
        </ModalOverlay>
      )}
    </>
  )
}

function transportTooltipKey(transport: SshServerState['transport']): string | null {
  if (transport === 'daemon') return '远端服务常驻运行；SSH 断线重连后可继续接回已持久化的终端。'
  if (transport === 'tunnel') return '经 SSH 隧道访问远端常驻服务；断线重连后可继续接回已持久化的终端。'
  if (transport === 'serve') return '远端服务按项目启动，在当前 SSH 会话中提供增强功能。'
  if (transport === 'direct') return '当前不运行远端服务，仅使用 SSH / SFTP 直连。'
  return null
}
