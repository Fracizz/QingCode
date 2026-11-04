import type { SshConnection } from '../types'

export interface SshImportCandidate {
  name: string
  host: string
  port: number
  username: string
  authKind: SshConnection['auth_kind']
  privateKeyPath: string | null
  issue: string | null
}

export interface SshImportCandidates {
  path: string
  candidates: SshImportCandidate[]
}

/** Different aliases for the same account/endpoint must not overwrite a saved connection. */
export function sshImportTarget(
  connection: Pick<SshConnection, 'host' | 'port' | 'username'>
): string {
  return JSON.stringify([connection.host.toLowerCase(), connection.port, connection.username])
}

export function connectionFromImport(candidate: SshImportCandidate): SshConnection {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: candidate.name,
    host: candidate.host,
    port: candidate.port,
    username: candidate.username,
    auth_kind: candidate.authKind,
    private_key_path: candidate.privateKeyPath ?? undefined,
    host_key_fingerprint: '',
    mode: 'server',
    created_at: now,
    updated_at: now,
  }
}
