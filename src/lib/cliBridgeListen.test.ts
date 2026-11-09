import { beforeEach, describe, expect, it, vi } from 'vitest'

const { windowListen, safeInvoke } = vi.hoisted(() => ({
  windowListen: vi.fn(async () => () => {}),
  safeInvoke: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ listen: windowListen }),
}))

vi.mock('./tauri', async importOriginal => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  isTauri: () => true,
  safeInvoke,
}))

import { listenForCliRequests } from './cliBridge'

describe('listenForCliRequests', () => {
  beforeEach(() => {
    windowListen.mockClear()
    safeInvoke.mockClear()
  })

  it('subscribes on the current window so other windows never run the request', async () => {
    await listenForCliRequests()
    expect(windowListen).toHaveBeenCalledWith('cli-request', expect.any(Function))
  })

  it('reports readiness only after the subscription exists', async () => {
    const order: string[] = []
    windowListen.mockImplementationOnce(async () => {
      order.push('listen')
      return () => {}
    })
    safeInvoke.mockImplementationOnce(async () => {
      order.push('ready')
      return undefined
    })
    await listenForCliRequests()
    expect(order).toEqual(['listen', 'ready'])
    expect(safeInvoke).toHaveBeenCalledWith(expect.any(String), 'cli_bridge_ready')
  })
})
