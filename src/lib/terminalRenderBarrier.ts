export const TERMINAL_RENDER_BARRIER_TIMEOUT_MS = 250

export type TerminalRenderBarrierResult = 'rendered' | 'unchanged' | 'timeout' | 'failed'

interface TerminalRenderBarrierTarget {
  onRender(listener: () => void): { dispose(): void }
}

/**
 * Wait for xterm to confirm that the render requested by `requestRender` ran.
 * The timeout is a safety valve for disposed/hidden terminals, not the normal path.
 */
export function waitForTerminalRender(
  terminal: TerminalRenderBarrierTarget,
  requestRender: () => boolean,
  timeoutMs = TERMINAL_RENDER_BARRIER_TIMEOUT_MS
): Promise<TerminalRenderBarrierResult> {
  return new Promise(resolve => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const finish = (result: TerminalRenderBarrierResult) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) globalThis.clearTimeout(timeout)
      subscription.dispose()
      resolve(result)
    }

    const subscription = terminal.onRender(() => finish('rendered'))
    try {
      if (!requestRender()) {
        finish('unchanged')
        return
      }
    } catch {
      finish('failed')
      return
    }

    if (!settled) {
      timeout = globalThis.setTimeout(() => finish('timeout'), timeoutMs)
    }
  })
}
