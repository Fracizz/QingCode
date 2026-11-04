import { safeInvoke } from './tauri'
import { SSH_CONNECTION_INVALIDATED_EVENT, SSH_CONNECTION_DISCONNECTED_EVENT } from './sshWorkspace'

export const CONNECTION_LATENCY_INTERVAL_MS = 30_000
export type ConnectionLatency = { milliseconds: number | null; checkedAt: number | null }
const EMPTY: ConnectionLatency = { milliseconds: null, checkedAt: null }
type Listener = () => void
type Entry = {
  snapshot: ConnectionLatency
  listeners: Map<Listener, string>
  timer?: ReturnType<typeof setTimeout>
  pending: boolean
  generation: number
  dispose?: () => void
}
const entries = new Map<string, Entry>()
const connectionId = (rootUri: string) => rootUri.split('/')[2]
const isVisible = () => document.visibilityState !== 'hidden'

export function getConnectionLatency(rootUri: string | null): ConnectionLatency {
  return (rootUri && entries.get(connectionId(rootUri))?.snapshot) || EMPTY
}

export function invalidateConnectionLatency(rootUri: string) {
  const entry = entries.get(connectionId(rootUri))
  if (!entry) return
  clearTimeout(entry.timer)
  entry.generation += 1
  entry.pending = false
  entry.snapshot = EMPTY
  entry.listeners.forEach((_, notify) => notify())
  if (!entry.listeners.size) {
    entries.delete(connectionId(rootUri))
    entry.dispose?.()
  }
}

/** One visible-window sampler per connection, shared by all mounted projects. */
export function subscribeConnectionLatency(rootUri: string, listener: Listener): () => void {
  const id = connectionId(rootUri)
  let entry = entries.get(id)
  const created = !entry
  if (!entry) {
    entry = { snapshot: EMPTY, listeners: new Map(), pending: false, generation: 0 }
    entries.set(id, entry)
  }
  const current = entry
  if (!current.listeners.size) clearTimeout(current.timer)
  current.listeners.set(listener, rootUri)
  const sample = async () => {
    if (entries.get(id) !== current || current.pending || !isVisible()) return
    clearTimeout(current.timer)
    current.pending = true
    const generation = current.generation
    let milliseconds: number | null = null
    try {
      const value = await safeInvoke<number>('测量 Server 往返延迟', 'ssh_server_latency', {
        rootUri: current.listeners.values().next().value,
      })
      if (Number.isFinite(value) && value >= 0) milliseconds = value
    } catch { /* Latency failures do not change connection health or show toasts. */ }
    if (entries.get(id) !== current || generation !== current.generation) return
    current.pending = false
    current.snapshot = { milliseconds, checkedAt: Date.now() }
    current.listeners.forEach((_, notify) => notify())
    if (entries.get(id) === current && current.listeners.size && isVisible()) {
      current.timer = setTimeout(() => void sample(), CONNECTION_LATENCY_INTERVAL_MS)
    }
  }
  const visibilityChanged = () => {
    if (!current.listeners.size) return
    clearTimeout(current.timer)
    if (isVisible()) void sample()
  }
  // Only the first subscriber owns the timer and visibility listener.
  if (created) {
    const invalidate = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) invalidateConnectionLatency(rootUri)
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
    window.addEventListener(SSH_CONNECTION_DISCONNECTED_EVENT, invalidate)
    current.dispose = () => {
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener(SSH_CONNECTION_INVALIDATED_EVENT, invalidate)
      window.removeEventListener(SSH_CONNECTION_DISCONNECTED_EVENT, invalidate)
    }
  }
  if (current.listeners.size === 1) {
    const age = current.snapshot.checkedAt === null ? Infinity : Date.now() - current.snapshot.checkedAt
    if (age >= CONNECTION_LATENCY_INTERVAL_MS) void sample()
    else if (isVisible()) current.timer = setTimeout(() => void sample(), CONNECTION_LATENCY_INTERVAL_MS - age)
  }
  // Each subscription can leave independently; the owner may leave first.
  return () => {
    current.listeners.delete(listener)
    if (current.listeners.size) return
    clearTimeout(current.timer)
    // Keep a fresh result across project switches, but never accept a late probe.
    current.generation += 1
    current.pending = false
    const remove = () => {
      if (entries.get(id) !== current) return
      entries.delete(id)
      current.dispose?.()
    }
    if (current.snapshot.checkedAt === null) remove()
    else current.timer = setTimeout(remove, CONNECTION_LATENCY_INTERVAL_MS)
  }
}
