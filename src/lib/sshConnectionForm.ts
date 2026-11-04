import type { SshConnection } from '../types'
import type { SshRuntimeConfig, SshSessionSecrets } from './sshWorkspace'

/** 连接编辑表单的可编辑字段；id / 指纹 / 时间戳由保存逻辑管理。 */
export interface SshConnectionForm {
  name: string
  host: string
  port: string
  username: string
  authKind: SshConnection['auth_kind']
  privateKeyPath: string
}

export function formFromConnection(connection: SshConnection): SshConnectionForm {
  return {
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    username: connection.username,
    authKind: connection.auth_kind,
    privateKeyPath: connection.private_key_path ?? '',
  }
}

export function emptyConnectionForm(): SshConnectionForm {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    authKind: 'privateKey',
    privateKeyPath: '',
  }
}

export function formEqualsConnection(
  form: SshConnectionForm,
  connection: SshConnection
): boolean {
  const base = formFromConnection(connection)
  return (
    form.name === base.name &&
    form.host === base.host &&
    form.port === base.port &&
    form.username === base.username &&
    form.authKind === base.authKind &&
    form.privateKeyPath === base.privateKeyPath
  )
}

/** 目标（主机/端口/用户名）是否变化。变化后旧指纹不再可信，必须重新测试确认。 */
export function targetChanged(form: SshConnectionForm, connection: SshConnection): boolean {
  return (
    form.host.trim() !== connection.host ||
    form.username.trim() !== connection.username ||
    Number.parseInt(form.port, 10) !== connection.port
  )
}

/** 返回错误文案或 null；与「打开 SSH 项目」对话框同一套校验口径。 */
export function validateConnectionForm(form: SshConnectionForm): string | null {
  if (!form.host.trim() || !form.username.trim()) return '请填写主机和用户名。'
  const port = Number.parseInt(form.port, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'SSH 端口必须在 1–65535 之间。'
  }
  return null
}

export function connectionFromForm(
  form: SshConnectionForm,
  base: Pick<SshConnection, 'id' | 'created_at'>,
  fingerprint: string
): SshConnection {
  const now = Date.now()
  return {
    id: base.id,
    name: form.name.trim() || form.host.trim(),
    host: form.host.trim(),
    port: Number.parseInt(form.port, 10),
    username: form.username.trim(),
    auth_kind: form.authKind,
    private_key_path: form.privateKeyPath.trim() || undefined,
    host_key_fingerprint: fingerprint,
    created_at: base.created_at,
    updated_at: now,
  }
}

/** 测试连接用的运行时配置；指纹由探测结果决定，不由表单携带。 */
export function runtimeConfigFromForm(
  form: SshConnectionForm,
  id: string,
  secrets: SshSessionSecrets
): SshRuntimeConfig {
  return {
    id,
    host: form.host.trim(),
    port: Number.parseInt(form.port, 10),
    username: form.username.trim(),
    authKind: form.authKind,
    privateKeyPath: form.privateKeyPath.trim() || undefined,
    ...secrets,
  }
}

/**
 * 指纹对比：`new` 表示还没有存档（首次连接，需信任确认）；
 * `changed` 表示远端身份与已存档不一致（需警惕中间人）。
 */
export function fingerprintStatus(
  stored: string | undefined | null,
  probed: string
): 'match' | 'changed' | 'new' {
  if (!stored) return 'new'
  return stored === probed ? 'match' : 'changed'
}
