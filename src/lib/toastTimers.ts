/** One clock drives both dismissal and the toast's CSS countdown. */
export function toastDuration(toast: { action?: unknown; detail?: string; kind?: string }): number {
  return toast.action ? 12000 : toast.kind === 'error' ? 8000 : toast.detail ? 6000 : 4000
}

export function createToastTimers() {
  const entries = new Map<string, { remaining: number; started: number; timer?: ReturnType<typeof setTimeout>; reasons: Set<string>; dismiss: () => void }>()
  const clear = (id: string) => {
    const entry = entries.get(id)
    if (entry?.timer != null) clearTimeout(entry.timer)
    entries.delete(id)
  }
  const schedule = (id: string) => {
    const entry = entries.get(id)
    if (!entry) return
    entry.started = Date.now()
    entry.timer = setTimeout(() => {
      clear(id)
      entry.dismiss()
    }, entry.remaining)
  }
  return {
    start(id: string, duration: number, dismiss: () => void) {
      clear(id)
      entries.set(id, { remaining: duration, started: Date.now(), reasons: new Set(), dismiss })
      schedule(id)
    },
    pause(id: string, reason: string) {
      const entry = entries.get(id)
      if (!entry || entry.reasons.has(reason)) return
      if (entry.reasons.size === 0) {
        if (entry.timer != null) clearTimeout(entry.timer)
        entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.started))
      }
      entry.reasons.add(reason)
    },
    resume(id: string, reason: string) {
      const entry = entries.get(id)
      if (!entry || !entry.reasons.delete(reason)) return
      if (entry.reasons.size === 0) schedule(id)
    },
    clear,
  }
}
