export interface FileWatchTargets {
  roots: string[]
  files: string[]
}

/** Keep one native request in flight and only the latest requested watch set. */
export function createFileWatchSync(
  apply: (targets: FileWatchTargets) => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  let queued: { targets: FileWatchTargets; force: boolean } | null = null
  let appliedKey: string | null = null
  let running = false
  let disposed = false

  async function drain() {
    running = true
    try {
      while (queued && !disposed) {
        const { targets, force } = queued
        queued = null
        const key = JSON.stringify(targets)
        if (!force && key === appliedKey) continue
        try {
          await apply(targets)
          appliedKey = key
        } catch (error) {
          onError(error)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    request(targets: FileWatchTargets, force = false) {
      if (disposed) return
      queued = { targets, force }
      if (!running) void drain()
    },
    dispose() {
      disposed = true
      queued = null
    },
  }
}
