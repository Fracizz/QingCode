/**
 * Build a `safeInvoke` implementation that dispatches by Tauri command name.
 *
 * Usage in a component test (the dispatcher is applied at runtime in
 * `beforeEach`, so importing this helper is fine — it never runs inside the
 * hoisted `vi.mock` factory):
 *
 * ```ts
 * const mocks = vi.hoisted(() => ({ safeInvoke: vi.fn() }))
 * vi.mock('../lib/tauri', () => ({
 *   isTauri: () => true,
 *   safeInvoke: mocks.safeInvoke,
 *   NotInTauriError: class NotInTauriError extends Error {},
 * }))
 * // in beforeEach:
 * mocks.safeInvoke.mockImplementation(createSafeInvokeDispatcher({ git_status: () => status }))
 * ```
 *
 * @param commands map of command name → handler receiving the `args` object.
 *                Unmatched commands resolve to `undefined`.
 */
export function createSafeInvokeDispatcher(
  commands: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {},
): (action: string, command: string, args?: Record<string, unknown>) => Promise<unknown> {
  return async (_action: string, command: string, args?: Record<string, unknown>) => {
    const handler = commands[command]
    return handler ? handler(args) : undefined
  }
}

/** Shared `NotInTauriError` shape for `vi.mock('../lib/tauri')` factories. */
export class NotInTauriError extends Error {
  constructor(action: string) {
    super(`Not in Tauri: ${action}`)
    this.name = 'NotInTauriError'
  }
}
