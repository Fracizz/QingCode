import { beforeEach, describe, expect, it, vi } from 'vitest'
import { safeInvoke } from './tauri'
import { searchFiles } from './searchFiles'

vi.mock('./tauri', () => ({ safeInvoke: vi.fn() }))

beforeEach(() => { vi.mocked(safeInvoke).mockReset() })

describe('searchFiles cancellation', () => {
  it('cancels only the superseded remote request and keeps completeness metadata', async () => {
    let finish!: (value: unknown) => void
    vi.mocked(safeInvoke).mockImplementation(async (_action, command) => {
      if (command === 'cancel_ssh_file_search') return
      return new Promise(resolve => { finish = resolve })
    })
    const controller = new AbortController()
    const pending = searchFiles('search', { root: 'ssh://one/project', query: 'hello' }, controller.signal)
    const requestId = vi.mocked(safeInvoke).mock.calls[0][2]?.requestId
    controller.abort()
    expect(safeInvoke).toHaveBeenCalledWith('取消文件搜索', 'cancel_ssh_file_search', { requestId })
    finish({ hits: [], truncated: false, cancelled: true })
    expect(await pending).toEqual({ hits: [], truncated: false, cancelled: true })
  })

  it('does not start work that was already superseded while loading settings', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await searchFiles('search', { root: 'ssh://one/project' }, controller.signal)).toMatchObject({ cancelled: true })
    expect(safeInvoke).not.toHaveBeenCalled()
  })

  it('removes its cancellation listener when the remote search finishes', async () => {
    vi.mocked(safeInvoke).mockResolvedValue({ hits: [], truncated: true, cancelled: false })
    const controller = new AbortController()
    expect(await searchFiles('search', { root: 'ssh://one/project' }, controller.signal)).toMatchObject({ truncated: true })
    controller.abort()
    expect(safeInvoke).toHaveBeenCalledOnce()
  })
})
