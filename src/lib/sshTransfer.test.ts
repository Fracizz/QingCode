import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import { safeInvoke } from './tauri'
import { startSshTransfer, cancelSshTransfer, retrySshTransfer } from './sshTransfer'
import { useTransferStore, type TransferProgress, type TransferRequest } from '../store/transferStore'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('./tauri', () => ({ safeInvoke: vi.fn() }))
vi.mock('../store/projectStore', () => ({ useProjectStore: { getState: () => ({ projects: [], refreshProjectTree: vi.fn() }) } }))
const request: TransferRequest = { direction: 'download', paths: ['ssh://c/a', 'ssh://c/b'], destination: 'D:/out' }
const unlisten = vi.fn()
let emit: (progress: TransferProgress) => void
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function progress(status: TransferProgress['status'], values: Partial<TransferProgress> = {}): TransferProgress {
  return { taskId: useTransferStore.getState().tasks.at(-1)!.taskId, status, completedFiles: 0, completedBytes: 0, completedPaths: [], pendingPaths: request.paths, ...values }
}
beforeEach(() => {
  useTransferStore.setState({ tasks: [] })
  unlisten.mockReset()
  vi.mocked(safeInvoke).mockReset()
  vi.mocked(listen).mockReset().mockImplementation(async (_name, handler) => {
    const callback = handler as (event: { payload: TransferProgress }) => void
    emit = payload => callback({ payload })
    return unlisten
  })
})

describe('SSH transfer lifecycle', () => {
  it('waits for its subscription before invoking even a tiny transfer', async () => {
    const subscribed = deferred<typeof unlisten>()
    vi.mocked(listen).mockReturnValueOnce(subscribed.promise)
    vi.mocked(safeInvoke).mockImplementation(async () => progress('completed'))
    const transfer = startSshTransfer(request)
    expect(listen).toHaveBeenCalledWith('ssh-transfer-progress', expect.any(Function))
    expect(safeInvoke).not.toHaveBeenCalled()
    subscribed.resolve(unlisten)
    expect((await transfer).status).toBe('completed')
    expect(safeInvoke).toHaveBeenCalledOnce()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('cancels a queued task without starting native work', async () => {
    const subscribed = deferred<typeof unlisten>()
    vi.mocked(listen).mockReturnValueOnce(subscribed.promise)
    const transfer = startSshTransfer(request)
    const id = useTransferStore.getState().tasks[0].taskId
    await cancelSshTransfer(id)
    expect(useTransferStore.getState().tasks[0].status).toBe('cancelling')
    subscribed.resolve(unlisten)
    expect((await transfer).status).toBe('cancelled')
    expect(safeInvoke).not.toHaveBeenCalled()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('keeps cancellation pending until native completion and ignores running progress during cancellation', async () => {
    const native = deferred<TransferProgress>()
    vi.mocked(safeInvoke).mockImplementation(async (_action, command) => command === 'ssh_transfer_paths' ? native.promise : undefined)
    const transfer = startSshTransfer(request)
    await vi.waitFor(() => expect(safeInvoke).toHaveBeenCalledOnce())
    const id = useTransferStore.getState().tasks[0].taskId
    await cancelSshTransfer(id)
    expect(safeInvoke).toHaveBeenCalledWith('取消传输', 'cancel_ssh_transfer', { taskId: id })
    emit(progress('running', { completedBytes: 25 }))
    expect(useTransferStore.getState().tasks[0]).toMatchObject({ status: 'cancelling', completedBytes: 25 })
    native.resolve(progress('cancelled'))
    expect((await transfer).status).toBe('cancelled')
  })

  it('does not replace terminal progress with late progress or an IPC failure', async () => {
    const native = deferred<TransferProgress>()
    vi.mocked(safeInvoke).mockReturnValue(native.promise)
    const transfer = startSshTransfer(request)
    await vi.waitFor(() => expect(safeInvoke).toHaveBeenCalledOnce())
    emit(progress('completed', { completedFiles: 2, completedBytes: 100, pendingPaths: [] }))
    emit(progress('running', { completedBytes: 1 }))
    native.reject(new Error('late transport disconnect'))
    const result = await transfer
    expect(result).toMatchObject({ status: 'completed', completedBytes: 100 })
    expect(useTransferStore.getState().tasks[0]).toMatchObject({ status: 'completed', completedBytes: 100 })
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('retries only pending paths after partial failure', async () => {
    vi.mocked(safeInvoke).mockImplementationOnce(async () => progress('failed', {
      completedFiles: 1, completedPaths: [request.paths[0]], pendingPaths: [request.paths[1]], error: 'broken connection',
    }))
    const failed = await startSshTransfer(request)
    vi.mocked(safeInvoke).mockImplementationOnce(async () => progress('completed', { pendingPaths: [] }))
    await retrySshTransfer(failed.taskId)
    expect(vi.mocked(safeInvoke).mock.calls[1][2]).toMatchObject({ paths: [request.paths[1]], destination: request.destination })
    expect(useTransferStore.getState().tasks).toHaveLength(1)
  })
})
