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

export function sshRootUri(connectionId: string, rootPath: string): string {
  const normalized =
    `/${rootPath.trim().replace(/\\/g, '/').replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/'
  return `ssh://${connectionId}${normalized}`
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

export async function connectSshWorkspace(
  project: Project,
  connection: SshConnection,
  secrets: SshSessionSecrets = {}
): Promise<void> {
  await safeInvoke('连接 SSH 项目', 'ssh_connect', {
    config: sshRuntimeConfig(connection, secrets),
    rootUri: project.path,
    trusted: isProjectTrusted(project),
  })
}

export async function ensureSshWorkspaceConnected(project: Project): Promise<void> {
  if (project.kind !== 'ssh' || !project.connection_id) return
  const connected = await safeInvoke<boolean>('检查 SSH 连接', 'ssh_connection_status', {
    connectionId: project.connection_id,
  })
  if (connected) return
  const connection = await getSshConnection(project.connection_id)
  if (!connection) throw new Error('SSH 连接配置不存在')
  if (connection.auth_kind === 'password') {
    throw new Error('SSH 密码未保存在本机，请从“打开 SSH 项目”重新连接')
  }
  await connectSshWorkspace(project, connection)
}
