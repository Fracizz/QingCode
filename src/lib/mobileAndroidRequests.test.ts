import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeRpc } from '../../mobile/android/web/nativeRpc.js'
import { createTerminalInput } from '../../mobile/android/web/terminalInput.js'
import { createDesktopProtocol } from '../../mobile/android/web/desktopProtocol.js'
import { uploadTerminalImages } from '../../mobile/android/web/terminalImages.js'

afterEach(() => { vi.useRealTimers() })

describe('native RPC deadlines', () => {
  it.each(['agent_create', 'agent_send', 'agent_image', 'agent_usage'])('preserves the native %s deadline instead of expiring at the terminal default', async op => {
    vi.useFakeTimers()
    const native = { request: vi.fn(), cancel: vi.fn() }
    const rpc = createNativeRpc(native)
    const result = rpc.request(op).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(native.cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync((op === 'agent_usage' ? 75_000 : 120_000) - 45_000)
    expect((await result).message).toContain('结果未知')
    expect(native.cancel).toHaveBeenCalledExactlyOnceWith(1)
  })
  it('cancels once, retains an unknown outcome and ignores a late native reply', async () => {
    vi.useFakeTimers()
    const native = { request: vi.fn(), cancel: vi.fn() }
    const rpc = createNativeRpc(native)
    const result = rpc.request('input', { data: 'do work' }).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(45_000)
    expect((await result).message).toContain('结果未知')
    expect(native.cancel).toHaveBeenCalledExactlyOnceWith(1)
    rpc.receive(1, { ok: true, data: null })
    expect(native.request).toHaveBeenCalledTimes(1)
    const next = rpc.request('input', { data: 'new work' })
    rpc.receive(2, { ok: true, data: null })
    expect(await next).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps user permission/picker requests open and clears timers after synchronous failures', async () => {
    vi.useFakeTimers()
    const native = { request: vi.fn(), cancel: vi.fn() }
    const rpc = createNativeRpc(native)
    const picker = rpc.request('pick_image')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(native.cancel).not.toHaveBeenCalled()
    rpc.receive(1, { ok: true, data: null })
    expect(await picker).toBeNull()
    native.request.mockImplementation(() => { throw new Error('bridge gone') })
    await expect(rpc.request('input')).rejects.toThrow('bridge gone')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('terminal input groups', () => {
  it('waits for text delivery before Enter and keeps later input behind the group', async () => {
    vi.useFakeTimers()
    const write = vi.fn().mockResolvedValue(null)
    const received = vi.fn()
    const input = createTerminalInput({ write, isCurrent: () => true, onSuccess: vi.fn(), onError: vi.fn() })
    const target = { id: 'a', address: 'pc', epoch: 1 }
    input.enqueue('text', target, { enter: '\r', onComplete: received })
    input.enqueue('later', target)
    await vi.advanceTimersByTimeAsync(249)
    expect(write.mock.calls.map(call => call[1])).toEqual(['text'])
    await vi.advanceTimersByTimeAsync(1)
    expect(write.mock.calls.map(call => call[1])).toEqual(['text', '\r', 'later'])
    expect(received).toHaveBeenCalledExactlyOnceWith('received')
  })

  it('does not send queued text or Enter after changing sessions', async () => {
    vi.useFakeTimers()
    let release!: () => void
    let current = true
    const write = vi.fn().mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const complete = vi.fn()
    const input = createTerminalInput({ write, isCurrent: () => current, onSuccess: vi.fn(), onError: vi.fn() })
    const target = { id: 'a', address: 'pc', epoch: 1 }
    input.enqueue('already in flight', target, { enter: '\r', onComplete: complete })
    input.enqueue('still queued', target, { enter: '\r', onComplete: complete })
    await vi.advanceTimersByTimeAsync(0)
    current = false
    release()
    await vi.advanceTimersByTimeAsync(250)
    expect(write).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls).toEqual([['unknown'], ['unknown']])
  })

  it('a failed write is not retried, and a later successful write restores current status', async () => {
    vi.useFakeTimers()
    const write = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue(null)
    const success = vi.fn(), failure = vi.fn(), receipt = vi.fn()
    const input = createTerminalInput({ write, isCurrent: () => true, onSuccess: success, onError: failure })
    const target = { id: 'a', address: 'pc', epoch: 1 }
    input.enqueue('first\r', target, { onComplete: receipt })
    await vi.advanceTimersByTimeAsync(22)
    input.enqueue('second\r', target, { onComplete: receipt })
    await vi.advanceTimersByTimeAsync(22)
    expect(write).toHaveBeenCalledTimes(2)
    expect(failure).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledTimes(1)
    expect(receipt.mock.calls).toEqual([['unknown'], ['received']])
    expect(input.enqueue('x'.repeat(32_769), target)).toBe(false)
  })
})

describe('desktop protocol negotiation', () => {
  const profile = { id: 'pc', fingerprint: 'pin' }
  const capabilities = { protocolVersion: 1, features: ['images'], sessionScope: 'shared' }
  it('uses one capabilities probe per certificate and invalidates after re-pairing', async () => {
    const remote = vi.fn().mockResolvedValue(capabilities)
    const protocol = createDesktopProtocol(remote)
    expect(await protocol.capabilities(profile)).toEqual(capabilities)
    await protocol.capabilities(profile)
    expect(remote).toHaveBeenCalledTimes(1)
    protocol.invalidate(profile)
    await protocol.capabilities(profile)
    await protocol.capabilities({ ...profile, fingerprint: 'new' })
    expect(remote).toHaveBeenCalledTimes(3)
  })
  it('recognizes old desktops but never caches a network or authorization failure as legacy', async () => {
    const remote = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(capabilities)
      .mockRejectedValueOnce(new Error('请求格式无效。'))
    const protocol = createDesktopProtocol(remote)
    await expect(protocol.capabilities(profile)).rejects.toThrow('offline')
    expect(await protocol.capabilities(profile)).toEqual(capabilities)
    expect(await protocol.capabilities({ ...profile, id: 'old' })).toBeNull()
  })
  it('rejects incompatible protocol versions', async () => {
    const protocol = createDesktopProtocol(vi.fn().mockResolvedValue({ ...capabilities, protocolVersion: 2 }))
    await expect(protocol.capabilities(profile)).rejects.toThrow('不兼容')
  })
})

describe('image upload lifecycle', () => {
  function bridge() {
    return vi.fn().mockImplementation(async (op: string, args: { index?: number }) => op === 'pick_image'
      ? { selection: 'uris', count: 2 } : op === 'read_image' ? { data: 'image-' + args.index } : true)
  }
  it('preserves the first inserted image on partial failure, releases handles and does not retry', async () => {
    const rpc = bridge(), inserted = vi.fn(), remote = vi.fn().mockResolvedValueOnce({ path: 'first' }).mockRejectedValueOnce(new Error('offline'))
    await expect(uploadTerminalImages({ rpc, remote, address: 'pc', id: 'a', compression: 'medium',
      isCurrent: () => true, onProgress: vi.fn(), onInsert: inserted })).rejects.toThrow('offline')
    expect(inserted).toHaveBeenCalledExactlyOnceWith('first')
    expect(remote).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenLastCalledWith('release_images', { selection: 'uris' })
  })
  it('does not insert a late image or read the next one after switching sessions', async () => {
    const rpc = bridge(), inserted = vi.fn()
    let current = true
    const remote = vi.fn().mockImplementation(async () => { current = false; return { path: 'late' } })
    await uploadTerminalImages({ rpc, remote, address: 'pc', id: 'a', compression: 'medium',
      isCurrent: () => current, onProgress: vi.fn(), onInsert: inserted })
    expect(inserted).not.toHaveBeenCalled()
    expect(rpc.mock.calls.filter(call => call[0] === 'read_image')).toHaveLength(1)
    expect(rpc).toHaveBeenLastCalledWith('release_images', { selection: 'uris' })
  })
})
