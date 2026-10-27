import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { isWebTest } from '../lib/webTestMode'
import { openWebTestDatabase } from './webTestDatabase'
import {
  WebTestBackend,
  initialTestEntries,
  TEST_FINGERPRINT,
  TEST_ROOT,
  TEST_REMOTE_ROOT,
} from './webTestBackend'
import { normalizeTestPath, pathWithin, type TestEntries } from './webTestFileSystem'
import { scopedStorage, testSessionId } from './webTestStorage'

function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
}

export async function installWebTestRuntime(): Promise<void> {
  if (!isWebTest()) throw new Error('Web test runtime is development-only')
  const session = testSessionId(location.search)
  const prefix = `qingcode:web-test:${session}:`
  const storage = window.localStorage
  const sessionStorage = window.sessionStorage
  const rawDisk = storage.getItem(`${prefix}disk`)
  const entries: TestEntries = rawDisk ? JSON.parse(rawDisk) : initialTestEntries()
  const rawDatabase = storage.getItem(`${prefix}database`)
  const db = await openWebTestDatabase(
    rawDatabase ? Uint8Array.from(atob(rawDatabase), char => char.charCodeAt(0)) : undefined,
    bytes => storage.setItem(`${prefix}database`, encode(bytes))
  )
  if (!rawDatabase) {
    db.execute('INSERT INTO settings (key, value) VALUES ($1, $2)', [
      'legacy_my_code_desktop_db_v1',
      'done',
    ])
    db.execute(
      'INSERT INTO ssh_connections (id, name, host, username, auth_kind, host_key_fingerprint, created_at, updated_at, mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        'web-test',
        'Web Test SSH',
        'web-test.invalid',
        'tester',
        'privateKey',
        TEST_FINGERPRINT,
        1,
        1,
        'server',
      ]
    )
  }
  const persistDisk = () => storage.setItem(`${prefix}disk`, JSON.stringify(entries))
  persistDisk()
  const backend = new WebTestBackend(entries, persistDisk, db, (event, payload) => {
    void emit(event, payload).catch(error => console.error('Web test event failed:', error))
  })
  mockIPC((command, args) => backend.invoke(command, args as Record<string, unknown>), {
    shouldMockEvents: true,
  })
  mockWindows('main')
  // Real Store persistence/settings/trust run unchanged within an isolated namespace.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: scopedStorage(storage, `${prefix}app:`),
  })
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: scopedStorage(sessionStorage, `${prefix}app:`),
  })
  const controls = {
    session,
    fixture: { localRoot: TEST_ROOT, remoteRoot: TEST_REMOTE_ROOT },
    queueDialog: (value: string | string[] | null) => {
      backend.dialogs.push(value)
    },
    readFile: (path: string) => backend.fs.read(path),
    externalWrite: (path: string, content: string) => {
      path = normalizeTestPath(path)
      if (![TEST_ROOT, TEST_REMOTE_ROOT, '/workspace/other'].some(root => pathWithin(path, root)))
        throw new Error('External writes are restricted to fixture projects')
      backend.fs.write(path, content)
    },
    failNext: (command: string, message?: string) => backend.failNext(command, message),
    setLatency: (command: string, milliseconds: number) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 30000)
        throw new Error('Latency must be 0–30000 ms')
      backend.latency.set(command, milliseconds)
    },
    terminalIds: () => [...backend.terminals.keys()],
    output: (id: string, text: string) => backend.output(id, text),
    exit: (id: string, code = 0) => backend.exit(id, code),
    disconnect: () => backend.disconnect(),
    reconnect: () => backend.reconnect(),
    calls: () => [...backend.calls],
    reset: () => {
      scopedStorage(storage, prefix).clear()
      scopedStorage(sessionStorage, prefix).clear()
      location.reload()
    },
  }
  Object.defineProperty(window, '__QINGCODE_TEST__', { configurable: true, value: controls })
  window.addEventListener(
    'pagehide',
    () => {
      clearMocks()
      db.close()
    },
    { once: true }
  )
}

export type WebTestControls = {
  session: string
  fixture: { localRoot: string; remoteRoot: string }
  queueDialog(value: string | string[] | null): void
  readFile(path: string): string
  externalWrite(path: string, content: string): void
  failNext(command: string, message?: string): void
  setLatency(command: string, milliseconds: number): void
  terminalIds(): string[]
  output(id: string, text: string): void
  exit(id: string, code?: number): void
  disconnect(): void
  reconnect(): void
  calls(): string[]
  reset(): void
}

declare global {
  interface Window {
    __QINGCODE_TEST__?: WebTestControls
  }
}
