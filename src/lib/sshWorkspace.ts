import type { Project, SshConnection, SshConnectionMode } from '../types'
import { getSshConnection, upsertSshConnection } from './projectRepository'
import { getSshServerEnabled, loadSshPreparationSettings } from './sshServerSettings'
import { safeInvoke } from './tauri'
import { hasDirectAgentConnection } from './directAgent'
import { parseSshServerState, type SshServerState } from './sshServerStatus'
import { isProjectTrusted } from './workspaceTrust'

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

export function requestSshReconnect(project: Project): void {
  window.dispatchEvent(new CustomEvent<Project>(SSH_RECONNECT_REQUEST_EVENT, { detail: project }))
}

export const NEW_SSH_CONNECTION_ID = '__new__'

const sessionSecrets = new Map<string, SshSessionSecrets>()
const workspaceConnectQueues = new Map<string, Promise<void>>()
const connectionModeQueues = new Map<string, Promise<void>>()
const suspendedBackgroundConnections = new Set<string>()

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
  if (!isSshProject(project)) return project.path
  const remote = project.root_path || sshRemotePathFromUri(project.path)
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
  const remote = sshRemotePathFromUri(path)
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
}

export async function isSshConnectionAlive(connectionId: string): Promise<boolean> {
  try {
    return await safeInvoke<boolean>('检查 SSH 连接', 'ssh_connection_status', { connectionId })
  } catch {
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
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    clearTimeout(timer)
  }
  const poll = async () => {
    try {
      const value = await safeInvoke('读取 SSH Agent 状态', 'ssh_server_info', { rootUri })
      const state = parseSshServerState(value)
      if (!stopped && state?.rootUri === rootUri) onState(state)
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
    await safeInvoke('准备 SSH 项目', 'ssh_prepare_workspace', {
      rootUri, ...(options ? { settings } : {}),
    })
    signal.throwIfAborted()
  } finally {
    stop()
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

/** 连接管理页：该连接下全部已注册根的代理状态聚合。 */
export async function listSshServerStates(connectionId: string): Promise<SshServerState[]> {
  try {
    const states = await safeInvoke<SshServerState[]>('查询远端服务状态', 'ssh_server_states', {
      connectionId,
    })
    return states.flatMap(state => {
      const parsed = parseSshServerState(state)
      return parsed ? [parsed] : []
    })
  } catch {
    return []
  }
}

export async function connectSshWorkspace(
  project: Project,
  connection: SshConnection,
  secrets: SshSessionSecrets = {}
): Promise<void> {
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
