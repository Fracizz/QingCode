import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openWebTestDatabase, type WebTestDatabase } from './webTestDatabase'
import {
  WebTestBackend,
  initialTestEntries,
  TEST_ROOT,
  TEST_REMOTE_ROOT,
  TEST_FINGERPRINT,
} from './webTestBackend'
import { WebTestFileSystem, normalizeTestPath } from './webTestFileSystem'
import { parseSshServerState, sshServerChip } from '../lib/sshServerStatus'

const wasmPath = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm')

describe('Web native boundary contract', () => {
  let db: WebTestDatabase
  let bytes: Uint8Array
  let backend: WebTestBackend
  const emit = vi.fn()
  const persist = vi.fn()

  beforeEach(async () => {
    db = await openWebTestDatabase(
      undefined,
      value => {
        bytes = value
      },
      wasmPath
    )
    emit.mockReset()
    persist.mockReset()
    backend = new WebTestBackend(initialTestEntries(), persist, db, emit)
    await backend.invoke('sync_project_roots', { roots: [TEST_ROOT] })
    await backend.invoke('sync_trusted_roots', { roots: [TEST_ROOT] })
    await backend.invoke('sync_file_watches', { roots: [TEST_ROOT], files: [] })
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  it('stores binary terminal attachments in memory and rejects destination paths', async () => {
    const path = (await backend.invoke('clipboard_store_file', {
      name: '截图.png',
      bytes: [0, 255, 128, 10],
    })) as string
    expect(path).toMatch(/^\/tmp\/attachments\//)
    expect(backend.attachments.get(path)).toEqual(Uint8Array.of(0, 255, 128, 10))
    await expect(
      backend.invoke('clipboard_store_file', { name: '../escape', bytes: [1] })
    ).rejects.toThrow()
    expect(backend.attachments.size).toBe(1)
  })

  it('executes production SQL and native migrations, preserves transactions, and reloads committed data', async () => {
    db.execute(
      'INSERT INTO projects (id, name, path, created_at, last_opened_at) VALUES ($1,$2,$3,$4,$5)',
      ['p', 'demo', TEST_ROOT, 1, 1]
    )
    db.execute('BEGIN IMMEDIATE')
    db.execute('UPDATE projects SET name = $1 WHERE id = $2', ['changed', 'p'])
    expect(db.select('SELECT name FROM projects')[0].name).toBe('changed')
    db.execute('ROLLBACK')
    expect(db.select('SELECT name FROM projects')[0].name).toBe('demo')
    db.execute('BEGIN IMMEDIATE')
    db.execute('UPDATE projects SET hidden = $1 WHERE id = $2', [1, 'p'])
    db.execute('COMMIT')
    const restored = await openWebTestDatabase(bytes, () => {}, wasmPath)
    try {
      expect(restored.select('SELECT name, hidden, kind FROM projects')).toEqual([
        { name: 'demo', hidden: 1, kind: 'local' },
      ])
      expect(() =>
        restored.execute(
          'INSERT INTO projects (id, name, path, created_at, last_opened_at) VALUES ($1,$2,$3,$4,$5)',
          ['other', 'duplicate', TEST_ROOT, 1, 1]
        )
      ).toThrow(/UNIQUE/)
    } finally {
      restored.close()
    }
  })

  it('keeps read, save, scan, search and external-change events on the same durable disk', async () => {
    const path = (await backend.invoke('create_file', {
      parent: TEST_ROOT,
      name: 'new.txt',
    })) as string
    await backend.invoke('write_file', { path, content: 'searchable text' })
    expect(await backend.invoke('read_file', { path })).toBe('searchable text')
    expect(await backend.invoke('scan_directory', { path: TEST_ROOT })).toContainEqual({
      name: 'new.txt',
      path,
      is_dir: false,
    })
    const searchId = await backend.invoke('start_content_search')
    expect(
      await backend.invoke('search_file_contents', {
        root: TEST_ROOT,
        query: 'searchable',
        searchId,
      })
    ).toMatchObject({ match_count: 1, cancelled: false })
    backend.fs.write(path, 'external content')
    expect(emit).toHaveBeenLastCalledWith('fs-change', { path, kind: 'modify', isDir: false })
    const restored = new WebTestFileSystem(
      JSON.parse(JSON.stringify(backend.fs.entries)),
      () => {},
      () => {}
    )
    expect(restored.read(path)).toBe('external content')
    expect(persist).toHaveBeenCalled()
  })

  it('enforces root/trust/domain boundaries and reports unsupported interfaces', async () => {
    await backend.invoke('sync_trusted_roots', { roots: [] })
    await expect(
      backend.invoke('read_file', { path: `${TEST_ROOT}/README.md` })
    ).resolves.toContain('QingCode')
    await expect(
      backend.invoke('write_file', { path: `${TEST_ROOT}/README.md`, content: 'bad' })
    ).rejects.toThrow('受限模式')
    await expect(backend.invoke('read_file', { path: '/workspace/other/secret' })).rejects.toThrow(
      '已注册项目'
    )
    expect(() => normalizeTestPath(`${TEST_ROOT}/../other`)).toThrow()
    expect(() => normalizeTestPath('C:\\workspace')).toThrow()
    await expect(backend.invoke('git_push')).rejects.toThrow('未实现接口')
    await expect(backend.invoke('plugin:sql|load', { db: 'sqlite:production.db' })).rejects.toThrow(
      'isolated'
    )
  })

  it('injects one-shot errors and delays without faking successful mutations', async () => {
    const path = `${TEST_ROOT}/README.md`
    const original = backend.fs.read(path)
    backend.failNext('write_file', 'disk full')
    await expect(backend.invoke('write_file', { path, content: 'lost' })).rejects.toThrow(
      'disk full'
    )
    expect(backend.fs.read(path)).toBe(original)
    vi.useFakeTimers()
    backend.latency.set('write_file', 100)
    const pending = backend.invoke('write_file', { path, content: 'saved' })
    expect(backend.fs.read(path)).toBe(original)
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(backend.fs.read(path)).toBe('saved')
  })

  it('rolls virtual disk mutations back when durable storage rejects a write', () => {
    const entries = initialTestEntries()
    const fs = new WebTestFileSystem(
      entries,
      () => {
        throw new Error('quota')
      },
      emit
    )
    const before = JSON.stringify(entries)
    expect(() => fs.write(`${TEST_ROOT}/README.md`, 'lost')).toThrow('quota')
    expect(() => fs.remove(`${TEST_ROOT}/src`)).toThrow('quota')
    expect(() => fs.relocate(`${TEST_ROOT}/src`, `${TEST_ROOT}/renamed`)).toThrow('quota')
    expect(JSON.stringify(entries)).toBe(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('preserves remote resource paths, rejects host identity changes and emits reconnect/exit events', async () => {
    const config = { id: 'web-test', hostKeyFingerprint: TEST_FINGERPRINT, mode: 'server' }
    await expect(
      backend.invoke('ssh_open_session', { config: { ...config, hostKeyFingerprint: 'changed' } })
    ).rejects.toThrow('指纹')
    await backend.invoke('ssh_connect', { config, rootUri: TEST_REMOTE_ROOT, trusted: true })
    await expect(
      backend.invoke('ssh_read_file', { path: `${TEST_REMOTE_ROOT}/README.md` })
    ).resolves.toContain('Simulated')
    await backend.invoke('ssh_create_terminal', { id: 't', cwd: TEST_REMOTE_ROOT })
    backend.disconnect()
    expect(sshServerChip(parseSshServerState(backend.serverState(TEST_REMOTE_ROOT)))).toEqual({
      kind: 'offline',
    })
    expect(emit).toHaveBeenCalledWith(
      'terminal-connection',
      expect.objectContaining({ id: 't', state: 'reconnecting' })
    )
    await expect(
      backend.invoke('ssh_read_file', { path: `${TEST_REMOTE_ROOT}/README.md` })
    ).rejects.toThrow('断开')
    backend.reconnect()
    expect(sshServerChip(parseSshServerState(backend.serverState(TEST_REMOTE_ROOT)))).toEqual({
      kind: 'agent',
    })
    expect(emit).toHaveBeenCalledWith('terminal-connection', {
      id: 't',
      state: 'attached',
      restore: 'replay',
    })
    backend.output('t', '中文 output')
    const payload = emit.mock.calls.at(-1)![1] as { data: string }
    expect(
      new TextDecoder().decode(Uint8Array.from(atob(payload.data), char => char.charCodeAt(0)))
    ).toBe('中文 output')
    backend.exit('t', 2)
    expect(emit).toHaveBeenLastCalledWith('terminal-exit', { id: 't', exit_code: 2 })
    expect(backend.terminals.has('t')).toBe(false)
  })
})
