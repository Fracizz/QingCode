import { normalizeProjectPath } from '../utils/fileTreeHelpers'

/** Batch all changed paths without postponing forever or overlapping scans. */
export function createWatcherTreeRefreshQueue(
  refresh: (paths: string[]) => Promise<void>,
  onError: (error: unknown) => void,
  delayMs = 500,
) {
  const pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let disposed = false

  const schedule = () => {
    if (disposed || running || timer !== null || pending.size === 0) return
    timer = setTimeout(() => {
      timer = null
      const paths = [...pending.values()]
      pending.clear()
      running = true
      void refresh(paths).catch(onError).finally(() => {
        running = false
        schedule()
      })
    }, delayMs)
  }

  return {
    enqueue(path: string) {
      if (disposed) return
      pending.set(normalizeProjectPath(path), path)
      schedule()
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      pending.clear()
    },
  }
}
