import type { Project, SshConnection, SshConnectionMode } from '../types'
import { getSshConnection, upsertSshConnection } from './projectRepository'
import { getSshServerEnabled } from './sshServerSettings'
import { safeInvoke } from './tauri'
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

export function requestSshReconnect(project: Project): void {
  window.dispatchEvent(new CustomEvent<Project>(SSH_RECONNECT_REQUEST_EVENT, { detail: project }))
}

export const NEW_SSH_CONNECTION_ID = '__new__'

const sessionSecrets = new Map<string, SshSessionSecrets>()
const workspaceConnectQueues = new Map<string, Promise<void>>()
const connectionModeQueues = new Map<string, Promise<void>>()

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
  connection: Pick<SshConnection, 'username' | 'host' | 'port'>
): string {
  const port = connection.port === 22 ? '' : `:${connection.port}`
  return `${connection.username}@${connection.host}${port}`
}

export function sshConnectionLabel(
  connection: Pick<SshConnection, 'name' | 'username' | 'host' | 'port'>
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
  connection?: Pick<SshConnection, 'id' | 'username' | 'host' | 'port'> | null,
  connections: ReadonlyArray<Pick<SshConnection, 'id' | 'username' | 'host' | 'port'>> = []
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
    Pick<SshConnection, 'id' | 'name' | 'username' | 'host' | 'port'>
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
  await safeInvoke('连接 SSH 项目', 'ssh_connect', {
    config: sshRuntimeConfig(connection, merged, mode),
    rootUri: project.path,
    trusted: isProjectTrusted(project),
  })
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

      await disconnectSshSession(connectionId)

      // 动态导入避免与 projectStore 形成模块环；其他打开的项目在激活时按新模式连接。
      const { useProjectStore } = await import('../store/projectStore')
      const project = useProjectStore.getState().currentProject
      if (!project || !projectUsesSshConnection(project, connectionId)) return
      await ensureSshWorkspaceConnected(project)
      await useProjectStore.getState().refreshProjectTree(project)
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

export async function ensureSshWorkspaceConnected(project: Project): Promise<void> {
  if (!isSshProject(project)) return
  const connectionId = project.connection_id || sshConnectionIdFromUri(project.path)
  if (!connectionId) throw new Error('SSH 项目缺少连接配置')

  const previous = workspaceConnectQueues.get(connectionId) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      // A live transport does not imply that this project's root is registered.
      // Projects sharing one connection must each register their full remote root.
      if (await isSshWorkspaceReady(project.path)) return

      const connection = await getSshConnection(connectionId)
      if (!connection) throw new Error('SSH 连接配置不存在')
      const connectionAlive = await isSshConnectionAlive(connectionId)
      if (
        !connectionAlive &&
        connection.auth_kind === 'password' &&
        !sshSecretsFor(connection.id).password
      ) {
        throw new Error('SSH 密码未保存在本机，请从“打开 SSH 项目”重新连接')
      }
      await connectSshWorkspace(project, connection)
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
