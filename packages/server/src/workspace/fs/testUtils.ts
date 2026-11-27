import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceContext } from '../registry'

export interface FakeCtx {
  ctx: WorkspaceContext
  events: Array<{ name: string; payload: unknown }>
  logs: string[]
  readonly closed: boolean
  readonly cleanupCount: number
  close(): void
}

const contexts: FakeCtx[] = []
const directories: string[] = []

export function fakeCtx(clientId = 1): FakeCtx {
  const events: Array<{ name: string; payload: unknown }> = []
  const logs: string[] = []
  const cleanups: Array<() => void> = []
  let closed = false
  const ctx: WorkspaceContext = {
    clientId,
    emit(name, payload) {
      if (!closed) events.push({ name, payload })
    },
    onClose(cleanup) {
      cleanups.push(cleanup)
    },
    log(message) {
      logs.push(message)
    },
  }
  const result: FakeCtx = {
    ctx,
    events,
    logs,
    get closed() {
      return closed
    },
    get cleanupCount() {
      return cleanups.length
    },
    close() {
      if (closed) return
      closed = true
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
  contexts.push(result)
  return result
}

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-fs-t16-'))
  directories.push(dir)
  return dir
}

export function cleanupAll(): void {
  for (const item of contexts.splice(0)) item.close()
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}
