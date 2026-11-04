import { beforeEach, describe, expect, it, vi } from 'vitest'
const { invoke, confirm, checkbox } = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(), checkbox: vi.fn() }))
vi.mock('./tauri', () => ({ safeInvoke: invoke }))
vi.mock('../store/confirmStore', () => ({ confirmDialog: confirm, confirmDialogWithCheckbox: checkbox }))
import { confirmSshServerRestart } from './sshWindowsRepair'

const uri = 'ssh://win/D:/app'
const t = (value: string) => value
const plan = { needsRepair: true, configSha256: 'a'.repeat(64), originalBytes: 2390, compactBytes: 430, activeConnections: 4 }
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(plan)
  confirm.mockReset().mockResolvedValue(true)
  checkbox.mockReset().mockResolvedValue({ confirmed: true, checked: true })
})

describe('Windows SSH repair confirmation', () => {
  it('offers checked-by-default repair and binds execution to the reviewed digest', async () => {
    expect(await confirmSshServerRestart(uri, t)).toBe(true)
    expect(checkbox).toHaveBeenCalledWith(expect.objectContaining({ checkbox: expect.objectContaining({ defaultChecked: true }) }))
    expect(invoke).toHaveBeenLastCalledWith('修复 Windows SSH 兼容性', 'ssh_windows_repair', { rootUri: uri, expectedSha256: plan.configSha256 })
  })
  it('does not modify sshd when unchecked, while allowing the ordinary restart', async () => {
    checkbox.mockResolvedValue({ confirmed: true, checked: false })
    expect(await confirmSshServerRestart(uri, t)).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('does not restart or repair on cancellation', async () => {
    checkbox.mockResolvedValue({ confirmed: false, checked: true })
    expect(await confirmSshServerRestart(uri, t)).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it.each(['ssh://linux/home/app', 'D:/app', 'ssh://linux/home/C:/app'])('keeps %s out of Windows repair', async root => {
    expect(await confirmSshServerRestart(root, t)).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    expect(checkbox).not.toHaveBeenCalled()
  })
  it('keeps ordinary restart available if preflight is unsupported or lacks permission', async () => {
    invoke.mockRejectedValue(new Error('administrator required'))
    expect(await confirmSshServerRestart(uri, t)).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(checkbox).not.toHaveBeenCalled()
  })
  it('does not offer a redundant repair for an already compact configuration', async () => {
    invoke.mockResolvedValue({ ...plan, needsRepair: false })
    expect(await confirmSshServerRestart(uri, t)).toBe(true)
    expect(checkbox).not.toHaveBeenCalled()
  })
  it('stops the restart workflow when repair or its rollback fails', async () => {
    invoke.mockResolvedValueOnce(plan).mockRejectedValueOnce(new Error('effective configuration differs'))
    await expect(confirmSshServerRestart(uri, t)).rejects.toThrow('effective configuration differs')
  })

  it('does not start preflight for a cancelled opening', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await confirmSshServerRestart(uri, t, true, controller.signal)).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([true, false])('ignores late preflight results after cancellation (needsRepair=%s)', async needsRepair => {
    let finish!: (value: typeof plan) => void
    invoke.mockImplementationOnce(() => new Promise<typeof plan>(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = confirmSshServerRestart(uri, t, true, controller.signal)
    controller.abort()
    finish({ ...plan, needsRepair })
    expect(await pending).toBe(false)
    expect(checkbox).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not start repair if the opening is cancelled while confirmation is pending', async () => {
    let finish!: (value: { confirmed: boolean; checked: boolean }) => void
    checkbox.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = confirmSshServerRestart(uri, t, true, controller.signal)
    await vi.waitFor(() => expect(checkbox).toHaveBeenCalledOnce())
    expect(checkbox.mock.calls[0][0].signal).toBe(controller.signal)
    controller.abort()
    finish({ confirmed: true, checked: true })
    expect(await pending).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
