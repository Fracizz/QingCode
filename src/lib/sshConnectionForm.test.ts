import { describe, expect, it } from 'vitest'
import {
  connectionFromForm,
  emptyConnectionForm,
  fingerprintStatus,
  formEqualsConnection,
  formFromConnection,
  runtimeConfigFromForm,
  targetChanged,
  validateConnectionForm,
} from './sshConnectionForm'
import type { SshConnection } from '../types'

const base: SshConnection = {
  id: 'conn-1',
  name: 'WinDev',
  host: '192.168.252.107',
  port: 28822,
  username: 'administrator',
  auth_kind: 'password',
  host_key_fingerprint: 'SHA256:abcd',
  created_at: 1000,
  updated_at: 2000,
}

describe('formFromConnection / formEqualsConnection', () => {
  it('round-trips a stored connection', () => {
    const form = formFromConnection(base)
    expect(form).toEqual({
      name: 'WinDev',
      host: '192.168.252.107',
      port: '28822',
      username: 'administrator',
      authKind: 'password',
      privateKeyPath: '',
    })
    expect(formEqualsConnection(form, base)).toBe(true)
  })

  it('detects edits including optional key path', () => {
    const form = { ...formFromConnection(base), port: '22', privateKeyPath: '~/.ssh/id_ed25519' }
    expect(formEqualsConnection(form, base)).toBe(false)
  })

  it('empty form is a blank private-key connection', () => {
    expect(emptyConnectionForm()).toEqual({
      name: '',
      host: '',
      port: '22',
      username: '',
      authKind: 'privateKey',
      privateKeyPath: '',
    })
  })
})

describe('targetChanged', () => {
  it('ignores name and auth edits', () => {
    const form = { ...formFromConnection(base), name: '改名', authKind: 'privateKey' as const }
    expect(targetChanged(form, base)).toBe(false)
  })

  it('flags host, username and port changes', () => {
    expect(targetChanged({ ...formFromConnection(base), host: '10.0.0.2' }, base)).toBe(true)
    expect(targetChanged({ ...formFromConnection(base), username: 'root' }, base)).toBe(true)
    expect(targetChanged({ ...formFromConnection(base), port: '22' }, base)).toBe(true)
  })
})

describe('validateConnectionForm', () => {
  it('requires host and username', () => {
    expect(validateConnectionForm(emptyConnectionForm())).toBe('请填写主机和用户名。')
  })

  it('bounds the port', () => {
    const invalid = (port: string) =>
      validateConnectionForm({ ...emptyConnectionForm(), host: 'h', username: 'u', port })
    expect(invalid('0')).toBe('SSH 端口必须在 1–65535 之间。')
    expect(invalid('65536')).toBe('SSH 端口必须在 1–65535 之间。')
    expect(invalid('abc')).toBe('SSH 端口必须在 1–65535 之间。')
    expect(invalid('22')).toBeNull()
  })
})

describe('connectionFromForm', () => {
  it('defaults the name to the host and keeps created_at', () => {
    const form = { ...formFromConnection(base), name: '  ' }
    const saved = connectionFromForm(form, base, 'SHA256:new')
    expect(saved.name).toBe('192.168.252.107')
    expect(saved.created_at).toBe(1000)
    expect(saved.updated_at).not.toBe(2000)
    expect(saved.host_key_fingerprint).toBe('SHA256:new')
  })

  it('drops empty private key path', () => {
    const saved = connectionFromForm(formFromConnection(base), base, 'SHA256:abcd')
    expect(saved.private_key_path).toBeUndefined()
  })
})

describe('runtimeConfigFromForm', () => {
  it('carries trimmed fields and secrets', () => {
    const form = { ...formFromConnection(base), username: ' admin ' }
    const config = runtimeConfigFromForm(form, base.id, { password: 'pw' })
    expect(config).toEqual({
      id: 'conn-1',
      host: '192.168.252.107',
      port: 28822,
      username: 'admin',
      authKind: 'password',
      password: 'pw',
    })
  })
})

describe('fingerprintStatus', () => {
  it('classifies new, matching and changed hosts', () => {
    expect(fingerprintStatus(null, 'SHA256:x')).toBe('new')
    expect(fingerprintStatus(undefined, 'SHA256:x')).toBe('new')
    expect(fingerprintStatus('SHA256:x', 'SHA256:x')).toBe('match')
    expect(fingerprintStatus('SHA256:old', 'SHA256:x')).toBe('changed')
  })
})
