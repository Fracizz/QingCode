import type { Project, SshConnection, SshConnectionMode } from '../types'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getSshConnection, listSshConnections, upsertSshConnection } from './projectRepository'
import { getSshServerEnabled, loadSshPreparationSettings } from './sshServerSettings'
import { safeInvoke } from './tauri'
import { isWslProject, wslDistroNameFromPath, wslDistroPathFromPath } from './wslWorkspace'
import { directAgentApi, directAgentSshCandidates, hasDirectAgentConnection, type DirectAgentInfo } from './directAgent'
import { parseSshServerState, sshServerVersionMismatch, type SshServerState } from './sshServerStatus'
import { isProjectTrusted } from './workspaceTrust'
import { directServerUpdateApi, updatePhaseLabels, validServerUpdatePackage, type UpdatePhase } from './directServerUpdate'
import { beginServerOperation, reportServerOperation, finishServerOperation, useServerOperationStore } from '../store/serverOperationStore'

export interface SshSessionSecrets {
  password?: string
  passphrase?: string
}

export interface SshRuntimeConfig {
  id: string
  host: string
  port: number
  username: string
  authKind: 'privateKey' | 'password'
  /** 连接时固定的工作区模式；旧调用方可省略，默认按连接配置解析。 */
  mode?: SshConnectionMode
  password?: string
  privateKeyPath?: string
  passphrase?: string
  hostKeyFingerprint?: string
}

export const SSH_RECONNECT_REQUEST_EVENT = 'qingcode:ssh-reconnect-request'

/** 连接被新建/编辑/删除后广播，打开中的对话框据此刷新连接列表。 */
export const SSH_CONNECTIONS_CHANGED_EVENT = 'qingcode:ssh-connections-changed'
export const SSH_CONNECTION_INVALIDATED_EVENT = 'qingcode:ssh-connection-invalidated'
export const SSH_CONNECTION_DISCONNECTED_EVENT = 'qingcode:ssh-connection-disconnected'
export const SSH_SERVER_UPDATED_EVENT = 'qingcode:ssh-server-updated'

export function requestSshReconnect(project: Project): void {
  window.dispatchEvent(new CustomEvent<Project>(SSH_RECONNECT_REQUEST_EVENT, { detail: project }))
}

export const NEW_SSH_CONNECTION_ID = '__new__'

const sessionSecrets = new Map<string, SshSessionSecrets>()
const workspaceConnectQueues = new Map<string, Promise<void>>()
const connectionModeQueues = new Map<string, Promise<void>>()
const suspendedBackgroundConnections = new Set<string>()
// Keep the settled attempt as well: passive preparation/status retries must not
// repeatedly restart the same user's daemon or keep retrying missing credentials.
const directUpdateAttempts = new Map<string, Promise<void>>()

async function tryAutomaticDirectUpdate(project: Project, signal: AbortSignal, onStart: () => void): Promise<boolean> {
  const id = project.connection_id || sshConnectionIdFromUri(project.path)
  if (!id || !isProjectTrusted(project) || isSshBackgroundSuspended(id)) return false
  signal.throwIfAborted()
  const info = await directAgentApi.info(id)
  if (!info?.enabled) return false
  onStart()
  // 按网关而非连接 id 去重：两条连接指向同一网关时不能并发重启它。
  const gateway = `${info.host.trim().toLowerCase()}:${info.port}`
  let attempt = directUpdateAttempts.get(gateway)
  if (!attempt) {
    attempt = (async () => {
      const candidates = directAgentSshCandidates(await listSshConnections(), info.host)
      await Promise.all(candidates.map(item => hydrateSshSecrets(item.id)))
      const ssh = candidates.find(connection => connection.id === id)
        ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (!ssh?.host_key_fingerprint || (ssh.auth_kind === 'password' && !sshSecretsFor(ssh.id).password)) {
        throw new Error('自动更新需要已确认指纹且可认证的 SSH 连接，请通过“更新远端服务”授权后重试')
      }
      // 共享的更新任务不绑定首个调用方的打开信号：取消打开或切到其他项目时
      // 更新在后台继续，否则失败结果会被缓存，后续打开不再自动更新。
      if (!isProjectTrusted(project) || isSshBackgroundSuspended(id)) throw new Error('项目授权或连接状态已变化')
      const target = {
        rootUri: project.path,
        sshConnectionId: ssh.id,
        config: sshRuntimeConfig(ssh, sshSecretsFor(ssh.id)),
      }
      beginServerOperation(project.path, project.name, 'update')
      const progress = (phase: UpdatePhase) => reportServerOperation(project.path,
        phase === 'connecting' ? 1 : phase === 'checkingPackage' || phase === 'downloading' ? 2 : phase === 'verifying' ? 4 : 3,
        updatePhaseLabels[phase])
      try {
        const settings = await loadSshPreparationSettings(project)
        const info = await directServerUpdateApi.prepare({ ...target, packageSource: settings.offlineDir
          ? { mode: 'offline', directory: settings.offlineDir }
          : { mode: 'automatic', allowDownload: false } }, progress)
        if (!validServerUpdatePackage(info)) throw new Error(info.problem ?? '服务包未通过校验')
        if (!isProjectTrusted(project) || isSshBackgroundSuspended(id)) throw new Error('项目授权或连接状态已变化')
        const value = await directServerUpdateApi.update({ ...target, packageDirectory: info.directory }, progress)
        const state = parseSshServerState(value)
        if (state?.phase !== 'readyServer' || state.transport !== 'agent') throw new Error(state?.reason ?? '远端服务尚未就绪')
        finishServerOperation(project.path)
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SSH_SERVER_UPDATED_EVENT, {
          detail: { rootUri: project.path, name: project.name },
        }))
      } catch (error) {
        finishServerOperation(project.path, String(error))
        throw error
      }
    })()
    directUpdateAttempts.set(gateway, attempt)
  }
  await attempt
  signal.throwIfAborted()
  return true
}

export function isSshBackgroundSuspended(id: string): boolean {
  return suspendedBackgroundConnections.has(id)
}

export async function waitForSshWorkspaceConnection(project: Project): Promise<void> {
  const id = project.connection_id || sshConnectionIdFromUri(project.path)
  if (id) await workspaceConnectQueues.get(id)?.catch(() => undefined)
}

/**
 * 旧库行 `mode` 为空时按旧全局值（ssh.server.enabled）解析；非法值同理。
 * 仅兼容已有连接，不用于新建连接的默认值；新建连接始终默认 Server。
 * 只用于连接前/切换前的一次性解析，不改变持久化行。
 */
export function resolveSshConnectionMode(
  connection: Pick<SshConnection, 'mode'>,
  globalDefaultEnabled: boolean
): SshConnectionMode {
  if (connection.mode === 'server' || connection.mode === 'ssh') return connection.mode
  return globalDefaultEnabled ? 'server' : 'ssh'
}

/** 判断项目是否挂在该连接下（显式字段优先，兼容只有 ssh:// URI 的旧行）。 */
export function projectUsesSshConnection(
  project: Pick<Project, 'connection_id' | 'path'>,
  connectionId: string
): boolean {
  return project.connection_id === connectionId || sshConnectionIdFromUri(project.path) === connectionId
}

function broadcastSshConnectionsChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SSH_CONNECTIONS_CHANGED_EVENT))
}

export function rememberSshSessionSecrets(id: string, secrets: SshSessionSecrets): void {
  if (secrets.password || secrets.passphrase) {
    sessionSecrets.set(id, { ...sessionSecrets.get(id), ...secrets })
    return
  }
}

export function sshSecretsFor(id: string, override: SshSessionSecrets = {}): SshSessionSecrets {
  return { ...sessionSecrets.get(id), ...override }
}

export function hasSshSessionSecrets(id: string): boolean {
  const cached = sessionSecrets.get(id)
  return Boolean(cached?.password || cached?.passphrase)
}

export function forgetSshSessionSecrets(id: string): void {
  sessionSecrets.delete(id)
}

/** 读取本机加密保存的凭据（Windows DPAPI / AES-GCM）；没有或解密失败时返回 null。 */
export async function loadSavedSshSecrets(id: string): Promise<SshSessionSecrets | null> {
  try {
    const value = await safeInvoke<SshSessionSecrets | null>('读取已保存的 SSH 凭据', 'ssh_secret_load', { id })
    return value && (value.password || value.passphrase) ? value : null
  } catch {
    return null
  }
}

/** 仅在“记住凭据”保持勾选时调用；两项都为空等同于删除。 */
export async function saveSshSecrets(id: string, secrets: SshSessionSecrets): Promise<void> {
  await safeInvoke('保存 SSH 凭据', 'ssh_secret_save', {
    id,
    secrets: { password: secrets.password || undefined, passphrase: secrets.passphrase || undefined },
  })
}

export async function deleteSavedSshSecrets(id: string): Promise<void> {
  await safeInvoke('删除已保存的 SSH 凭据', 'ssh_secret_delete', { id })
}

/** 把已保存的凭据载入内存会话缓存（不覆盖本次已输入的值）；之后同步读取方可直接使用。 */
export async function hydrateSshSecrets(id: string): Promise<void> {
  if (hasSshSessionSecrets(id)) return
  const saved = await loadSavedSshSecrets(id)
  if (saved) rememberSshSessionSecrets(id, saved)
}

export interface SshBrowseEntry {
  name: string
  path: string
  is_dir: boolean
}

export interface SshBrowseResult {
  path: string
  entries: SshBrowseEntry[]
}

export interface SshSessionOpenResult {
  fingerprint: string
  homePath: string
}

export function normalizeRemotePath(path: string): string {
  return `/${path.trim().replace(/\\/g, '/').replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/'
}

export function parentRemotePath(path: string): string {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

export function sshRootUri(connectionId: string, rootPath: string): string {
  const normalized = normalizeRemotePath(rootPath)
  return normalized === '/' ? `ssh://${connectionId}/` : `ssh://${connectionId}${normalized}`
}

export function sshConnectionTarget(
  connection: Pick<SshConnection, 'username' | 'host' | 'port' | 'agentEndpoint'>
): string {
  if (connection.agentEndpoint) {
    const { host, port } = connection.agentEndpoint
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `${address}:${port}`
  }
  const port = connection.port === 22 ? '' : `:${connection.port}`
  return `${connection.username}@${connection.host}${port}`
}

export function sshConnectionLabel(
  connection: Pick<SshConnection, 'name' | 'username' | 'host' | 'port' | 'agentEndpoint'>
): string {
  const target = sshConnectionTarget(connection)
  const name = connection.name.trim()
  return name && name !== connection.host ? `${name}（${target}）` : target
}

export function findSshProject(
  projects: Project[],
  connectionId: string,
  rootPath: string
): Project | undefined {
  const path = sshRootUri(connectionId, rootPath)
  return projects.find(project => project.path === path)
}

export function isSshProject(project: Pick<Project, 'kind' | 'path'> | null | undefined): boolean {
  return Boolean(project && (project.kind === 'ssh' || project.path.startsWith('ssh://')))
}

export function sshConnectionIdFromUri(path: string): string | undefined {
  const match = path.match(/^ssh:\/\/([^/]+)/)
  return match?.[1] || undefined
}

export function sshRemotePathFromUri(path: string): string {
  const remote = path.replace(/^ssh:\/\/[^/]+/, '')
  return remote || '/'
}

/**
 * 远端路径的展示形式。Windows OpenSSH 的 SFTP 路径写作 `/D:/code/app`，
 * 内部仍按这个形式寻址，只在展示时去掉盘符前的斜杠。
 */
export function sshRemoteDisplayPath(remote: string): string {
  return /^\/[A-Za-z]:(?:\/|$)/.test(remote) ? remote.slice(1) : remote
}

/** Join POSIX segments onto an `ssh://` resource without touching the connection id. */
export function joinSshResource(root: string, ...segments: string[]): string {
  const connectionId = sshConnectionIdFromUri(root)
  if (!connectionId) return root
  let remote = sshRemotePathFromUri(root)
  for (const segment of segments) {
    const name = segment.trim().replace(/^\/+|\/+$/g, '')
    if (!name) continue
    remote = remote === '/' ? `/${name}` : `${remote.replace(/\/+$/, '')}/${name}`
  }
  return sshRootUri(connectionId, remote)
}

export function sshProjectDisplayPath(
  project: Pick<Project, 'kind' | 'path' | 'root_path' | 'connection_id'>,
  connection?: Pick<SshConnection, 'id' | 'username' | 'host' | 'port' | 'agentEndpoint'> | null,
  connections: ReadonlyArray<Pick<SshConnection, 'id' | 'username' | 'host' | 'port' | 'agentEndpoint'>> = []
): string {
  if (isWslProject(project)) {
    // 与 SSH 的「主机:路径」一致，显示「发行版:/posix/路径」而非 wsl.localhost 的 UNC 路径。
    const distro = wslDistroNameFromPath(project.path)
    const posix = wslDistroPathFromPath(project.path)
    if (posix) return distro ? `${distro}:${posix}` : posix
  }
  if (!isSshProject(project)) return project.path
  const remote = sshRemoteDisplayPath(project.root_path || sshRemotePathFromUri(project.path))
  const resolved =
    connection ??
    connections.find(
      item => item.id === project.connection_id || item.id === sshConnectionIdFromUri(project.path)
    )
  return resolved ? `${sshConnectionTarget(resolved)}:${remote}` : remote
}

/** Human-readable path for an `ssh://` file resource: connection label + remote path, never the internal id. */
export function sshFileDisplayPath(
  path: string,
  connections: ReadonlyArray<
    Pick<SshConnection, 'id' | 'name' | 'username' | 'host' | 'port' | 'agentEndpoint'>
  > = []
): string {
  const connectionId = sshConnectionIdFromUri(path)
  if (!connectionId) return path
  const remote = sshRemoteDisplayPath(sshRemotePathFromUri(path))
  const connection = connections.find(item => item.id === connectionId)
  return connection ? `${sshConnectionLabel(connection)}:${remote}` : remote
}

export function sshRuntimeConfig(
  connection: SshConnection,
  secrets: SshSessionSecrets = {},
  mode: SshConnectionMode = resolveSshConnectionMode(connection, getSshServerEnabled())
): SshRuntimeConfig {
  return {
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authKind: connection.auth_kind,
    mode,
    privateKeyPath: connection.private_key_path,
    hostKeyFingerprint: connection.host_key_fingerprint,
    ...secrets,
  }
}

export async function probeSshHost(
  config: Omit<SshRuntimeConfig, 'hostKeyFingerprint'>
): Promise<string> {
  const result = await safeInvoke<{ fingerprint: string }>('获取 SSH 主机指纹', 'ssh_probe_host', {
    config,
  })
  return result.fingerprint
}

export async function openSshSession(config: SshRuntimeConfig): Promise<SshSessionOpenResult> {
  return safeInvoke<SshSessionOpenResult>('打开 SSH 会话', 'ssh_open_session', { config })
}

/** Authenticate independently without registering or changing a workspace session. */
export async function testSshConnection(config: SshRuntimeConfig): Promise<SshSessionOpenResult> {
  return safeInvoke<SshSessionOpenResult>('测试 SSH 连接', 'ssh_test_connection', { config })
}

export async function browseSshDirectory(
  connectionId: string,
  path: string
): Promise<SshBrowseResult> {
  return safeInvoke<SshBrowseResult>('浏览远程目录', 'ssh_browse_directory', {
    connectionId,
    path,
  })
}

export async function disconnectSshSession(connectionId: string): Promise<void> {
  suspendedBackgroundConnections.add(connectionId)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SSH_CONNECTION_INVALIDATED_EVENT, { detail: connectionId }))
  }
  // An authentication already in flight must settle before native disconnect,
  // otherwise its late result can resurrect the explicitly closed session.
  await workspaceConnectQueues.get(connectionId)?.catch(() => undefined)
  await safeInvoke('断开 SSH 连接', 'ssh_disconnect', { connectionId })
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SSH_CONNECTION_DISCONNECTED_EVENT, { detail: connectionId }))
  }
}

/** Preserve pairing and the SSH identity; detach the direct transport before disabling it. */
export async function restoreSshTransport(connection: SshConnection, info: DirectAgentInfo, mode: SshConnectionMode): Promise<DirectAgentInfo> {
  if (connection.username === 'Agent' && connection.auth_kind === 'password' && connection.host_key_fingerprint === info.certificateFingerprint) {
    throw new Error('此连接尚未配置 SSH 身份，请先新建 SSH 连接。')
  }
  await disconnectSshSession(connection.id)
  await upsertSshConnection({ ...connection, mode, updated_at: Date.now() })
  await directAgentApi.save({ connectionId: connection.id, host: info.host, port: info.port, certificateFingerprint: info.certificateFingerprint, enabled: false })
  broadcastSshConnectionsChanged()
  return { ...info, enabled: false }
}

/** Overview checks propagate failures; workspace fast paths retain a false fallback. */
export async function isSshConnectionAlive(connectionId: string, strict = false): Promise<boolean> {
  try {
    return await safeInvoke<boolean>('检查 SSH 连接', 'ssh_connection_status', { connectionId })
  } catch (error) {
    if (strict) throw error
    return false
  }
}

export async function isSshWorkspaceReady(rootUri: string): Promise<boolean> {
  try {
    return await safeInvoke<boolean>('检查 SSH 项目连接', 'ssh_workspace_status', { rootUri })
  } catch {
    return false
  }
}

/** Registration only proves SSH/SFTP is connected. Wait for the service and
 * daemon needed by files and terminals before activating a Server workspace. */
export async function prepareSshWorkspace(
  rootUri: string,
  signal: AbortSignal,
  onState: (state: SshServerState) => void,
  options?: { project: Project; background?: boolean },
): Promise<void> {
  let stopped = false
  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    clearTimeout(timer)
  }
  const accept = (state: SshServerState) => {
    if (state.rootUri !== rootUri) return
    if (!stopped) onState(state)
    const existing = useServerOperationStore.getState().tasks[rootUri]
    if (options && state.phase === 'installing' && (!existing || existing.finishedAt)) {
      beginServerOperation(rootUri, options.project.name, 'install')
    }
    const task = useServerOperationStore.getState().tasks[rootUri]
    if (task?.kind === 'install' && !task.finishedAt) {
      if (state.phase === 'installing') reportServerOperation(rootUri, 3, '安装 QingCode Server')
      if (state.phase === 'handshaking') reportServerOperation(rootUri, 4, '正在验证远端服务与配对身份…')
    }
  }
  const poll = async () => {
    try {
      const value = await safeInvoke('读取 SSH Server 状态', 'ssh_server_info', { rootUri })
      const state = parseSshServerState(value)
      if (state) accept(state)
    } catch {
      // Preparation owns the authoritative result; a missed snapshot is harmless.
    }
    if (!stopped) timer = setTimeout(() => void poll(), 1000)
  }
  signal.throwIfAborted()
  const settings = options ? await loadSshPreparationSettings(options.project) : undefined
  signal.throwIfAborted()
  signal.addEventListener('abort', stop, { once: true })
  if (!options?.background) void poll()
  try {
    try {
      unlisten = await listen<unknown>('ssh-server-state', event => {
        const state = parseSshServerState(event.payload)
        if (state) accept(state)
      })
    } catch { /* Older runtimes still expose progress through status queries. */ }
    signal.throwIfAborted()
    const prepare = () => safeInvoke('准备 SSH 项目', 'ssh_prepare_workspace', {
      rootUri, ...(options ? { settings } : {}),
    })
    try {
      await prepare()
    } catch (error) {
      signal.throwIfAborted()
      if (!options || !sshServerVersionMismatch(String(error))) throw error
      try {
        if (!await tryAutomaticDirectUpdate(options.project, signal, () => onState({
          connectionId: options.project.connection_id || sshConnectionIdFromUri(rootUri) || '', rootUri,
          phase: 'installing', mode: 'server', connectionMode: 'server', version: null, transport: 'agent', reason: null,
        }))) throw error
      } catch (updateError) {
        throw Object.assign(new Error(`${String(error)}；${String(updateError)}`), { cause: updateError })
      }
      await prepare()
    }
    if (useServerOperationStore.getState().tasks[rootUri]?.kind === 'install') finishServerOperation(rootUri)
    signal.throwIfAborted()
  } catch (error) {
    if (useServerOperationStore.getState().tasks[rootUri]?.kind === 'install') finishServerOperation(rootUri, String(error))
    throw error
  } finally {
    stop()
    unlisten?.()
    signal.removeEventListener('abort', stop)
  }
}

/** Presentation hint only; does not authorize or skip project preparation. */
export async function isSshSharedServerReady(rootUri: string): Promise<boolean> {
  try {
    return Boolean(await safeInvoke('检查共享远端服务', 'ssh_shared_server_ready', { rootUri }))
  } catch {
    return false
  }
}

export async function activateSshWorkspace(rootUri: string): Promise<void> {
  await safeInvoke('启用 SSH 项目监听', 'ssh_activate_workspace', { rootUri })
}

export interface SshWorkspaceRoot {
  rootUri: string
  trusted: boolean
}

/** 连接管理页：该连接当前会话下已注册的项目根。连接断开后为空。 */
export async function listSshWorkspaceRoots(connectionId: string): Promise<SshWorkspaceRoot[]> {
  try {
    return await safeInvoke<SshWorkspaceRoot[]>('列出 SSH 项目根', 'ssh_workspace_roots', {
      connectionId,
    })
  } catch {
    return []
  }
}

/** 连接管理页：该连接下全部已注册根的代理状态聚合。strict 保留查询失败供概览展示。 */
export async function listSshServerStates(connectionId: string, strict = false): Promise<SshServerState[]> {
  try {
    const states = await safeInvoke<SshServerState[]>('查询远端服务状态', 'ssh_server_states', {
      connectionId,
    })
    return states.flatMap(state => {
      const parsed = parseSshServerState(state)
      return parsed ? [parsed] : []
    })
  } catch (error) {
    if (strict) throw error
    return []
  }
}

export async function connectSshWorkspace(
  project: Project,
  connection: SshConnection,
  secrets: SshSessionSecrets = {}
): Promise<void> {
  await hydrateSshSecrets(connection.id)
  const merged = sshSecretsFor(connection.id, secrets)
  const mode = resolveSshConnectionMode(connection, getSshServerEnabled())
  // 旧库行没有 mode：按全局默认解析后回填一次；失败不阻断连接。
  if (connection.mode !== mode) {
    try {
      await upsertSshConnection({ ...connection, mode })
    } catch (error) {
      console.warn('persist resolved ssh connection mode failed:', error)
    }
  }
  const trusted = isProjectTrusted(project)
  await safeInvoke('连接 SSH 项目', 'ssh_connect', {
    config: sshRuntimeConfig(connection, merged, mode),
    rootUri: project.path,
    trusted,
    deferService: true,
  })
  // Trust can be revoked while authentication is awaiting a network response.
  // Registration was passive, so reconcile before allowing service execution.
  if (trusted && !isProjectTrusted(project)) {
    await safeInvoke('同步 SSH 项目信任状态', 'ssh_set_workspace_trust', { rootUri: project.path, trusted: false })
  }
  rememberSshSessionSecrets(connection.id, merged)
}

/**
 * 切换连接配置的模式：写库后断开并按新模式重连当前项目。
 * 同一连接的切换串行执行，重复点击只会在第一次真正断开一次。
 */
export async function switchSshConnectionMode(
  connectionId: string,
  mode: SshConnectionMode
): Promise<void> {
  const previous = connectionModeQueues.get(connectionId) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const connection = await getSshConnection(connectionId)
      if (!connection) throw new Error('SSH 连接配置不存在')
      const previousMode = resolveSshConnectionMode(connection, getSshServerEnabled())
      if (previousMode === mode) return
      await upsertSshConnection({ ...connection, mode })
      broadcastSshConnectionsChanged()

      if (!(await isSshConnectionAlive(connectionId))) return

      // Server → SSH：尽力停掉远端服务，单个根失败只记录，不阻断切模式。
      if (previousMode === 'server' && mode === 'ssh') {
        const roots = await listSshWorkspaceRoots(connectionId)
        for (const root of roots) {
          try {
            await safeInvoke('停止远端服务', 'ssh_server_stop', { rootUri: root.rootUri })
          } catch (error) {
            console.warn('stop ssh server before switching mode failed:', error)
          }
        }
      }

      await reconnectSshConnection(connectionId)
    })
  connectionModeQueues.set(connectionId, current)

  try {
    await current
  } finally {
    if (connectionModeQueues.get(connectionId) === current) {
      connectionModeQueues.delete(connectionId)
    }
  }
}

/** Reconnect the active root; other roots register again when next activated. */
export async function reconnectSshConnection(connectionId: string): Promise<void> {
  await disconnectSshSession(connectionId)
  const { useProjectStore } = await import('../store/projectStore')
  const project = useProjectStore.getState().currentProject
  if (!project || !projectUsesSshConnection(project, connectionId)) return
  try {
    await ensureSshWorkspaceConnected(project)
  } catch (error) {
    if (String(error).includes('SSH 密码未保存在本机')) {
      requestSshReconnect(project)
      return
    }
    throw error
  }
  await prepareSshWorkspace(project.path, new AbortController().signal, () => {}, { project })
  await activateSshWorkspace(project.path)
  await useProjectStore.getState().refreshProjectTree(project)
}

export async function ensureSshWorkspaceConnected(
  project: Project,
  options?: { background: boolean; signal: AbortSignal },
): Promise<void> {
  if (!isSshProject(project)) return
  const connectionId = project.connection_id || sshConnectionIdFromUri(project.path)
  if (!connectionId) throw new Error('SSH 项目缺少连接配置')

  const previous = workspaceConnectQueues.get(connectionId) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      options?.signal.throwIfAborted()
      if (options?.background && suspendedBackgroundConnections.has(connectionId)) {
        throw new Error('SSH 连接已主动断开')
      }
      if (!options?.background) suspendedBackgroundConnections.delete(connectionId)
      // A live transport does not imply that this project's root is registered.
      // Projects sharing one connection must each register their full remote root.
      if (await isSshWorkspaceReady(project.path)) return

      const connection = await getSshConnection(connectionId)
      if (!connection) throw new Error('SSH 连接配置不存在')
      const connectionAlive = await isSshConnectionAlive(connectionId)
      if (!connectionAlive) await hydrateSshSecrets(connectionId)
      const directEnabled = !connectionAlive && connection.auth_kind === 'password'
        ? await hasDirectAgentConnection(connectionId)
        : false
      if (
        !connectionAlive &&
        !directEnabled &&
        connection.auth_kind === 'password' &&
        !sshSecretsFor(connection.id).password
      ) {
        throw new Error('SSH 密码未保存在本机，请从“打开 SSH 项目”重新连接')
      }
      await connectSshWorkspace(project, connection)
      options?.signal.throwIfAborted()
    })
  workspaceConnectQueues.set(connectionId, current)

  try {
    await current
  } finally {
    if (workspaceConnectQueues.get(connectionId) === current) {
      workspaceConnectQueues.delete(connectionId)
    }
  }
}
