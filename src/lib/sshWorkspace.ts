import type { Project, SshConnection } from '../types'
import { getSshConnection } from './projectRepository'
import { safeInvoke } from './tauri'
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
  password?: string
  privateKeyPath?: string
  passphrase?: string
  hostKeyFingerprint?: string
}

export const SSH_RECONNECT_REQUEST_EVENT = 'qingcode:ssh-reconnect-request'

export function requestSshReconnect(project: Project): void {
  window.dispatchEvent(new CustomEvent<Project>(SSH_RECONNECT_REQUEST_EVENT, { detail: project }))
}

export const NEW_SSH_CONNECTION_ID = '__new__'

const sessionSecrets = new Map<string, SshSessionSecrets>()

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

export function sshConnectionLabel(connection: SshConnection): string {
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

export function sshRuntimeConfig(
  connection: SshConnection,
  secrets: SshSessionSecrets = {}
): SshRuntimeConfig {
  return {
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authKind: connection.auth_kind,
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

export async function connectSshWorkspace(
  project: Project,
  connection: SshConnection,
  secrets: SshSessionSecrets = {}
): Promise<void> {
  const merged = sshSecretsFor(connection.id, secrets)
  await safeInvoke('连接 SSH 项目', 'ssh_connect', {
    config: sshRuntimeConfig(connection, merged),
    rootUri: project.path,
    trusted: isProjectTrusted(project),
  })
  rememberSshSessionSecrets(connection.id, merged)
}

export async function ensureSshWorkspaceConnected(project: Project): Promise<void> {
  if (project.kind !== 'ssh' || !project.connection_id) return
  if (await isSshConnectionAlive(project.connection_id)) return
  const connection = await getSshConnection(project.connection_id)
  if (!connection) throw new Error('SSH 连接配置不存在')
  if (connection.auth_kind === 'password' && !sshSecretsFor(connection.id).password) {
    throw new Error('SSH 密码未保存在本机，请从“打开 SSH 项目”重新连接')
  }
  await connectSshWorkspace(project, connection)
}
