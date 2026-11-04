// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileConnectionSettings from './MobileConnectionSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), choose: vi.fn() }))

vi.mock('@/lib/tauri', () => ({ isTauri: () => true, safeInvoke: mocks.invoke }))
vi.mock('@/store/choiceStore', () => ({ choiceDialog: mocks.choose }))

function status(port: number | null) {
  return { port, paired: port !== null, fingerprint: port === null ? null : 'sha256-test' }
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.choose.mockReset()
})

describe('Android mobile connection settings', () => {
  it('starts without an IP field and reports saving and successful activation', async () => {
    let complete: (value: ReturnType<typeof status>) => void = () => {}
    let current = status(null)
    mocks.invoke.mockImplementation((_label, command) => {
      if (command === 'mobile_saved_settings') return Promise.resolve({ port: 48764, configured: false })
      if (command === 'mobile_status') return Promise.resolve(current)
      return new Promise(resolve => { complete = value => { current = value; resolve(value) } })
    })
    render(<MobileConnectionSettings />)
    const save = screen.getByRole('button', { name: '保存并启用' })
    await waitFor(() => expect(save).toBeEnabled())
    expect(screen.queryByRole('textbox', { name: /IPv4/ })).toBeNull()
    fireEvent.click(save)
    expect(screen.getByRole('alert')).toHaveTextContent('请输入 6 位验证码')
    fireEvent.change(screen.getByLabelText('移动连接验证码'), { target: { value: 'A8z2D3' } })
    fireEvent.click(save)
    expect(screen.getByRole('status')).toHaveTextContent('正在保存并检查端口')
    expect(mocks.invoke).toHaveBeenCalledWith('保存移动连接', 'mobile_start', { port: 48764, code: 'A8z2D3' })
    complete(status(48764))
    expect(await screen.findByText(/已保存并启用移动连接/)).toBeVisible()
  })

  it('confirms a switch, retains the active port on failure, and reports the released port on success', async () => {
    let current = status(48764)
    let conflict = true
    mocks.choose.mockResolvedValueOnce('cancel').mockResolvedValue('switch')
    mocks.invoke.mockImplementation((_label, command) => {
      if (command === 'mobile_saved_settings') return Promise.resolve({ port: 48764, configured: true })
      if (command === 'mobile_status') return Promise.resolve(current)
      if (conflict) return Promise.reject(new Error('端口已被占用'))
      current = status(49123)
      return Promise.resolve(current)
    })
    render(<MobileConnectionSettings />)
    expect(await screen.findByText(/已启用 · TCP 48764/)).toBeVisible()
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '49123' } })
    const change = screen.getByRole('button', { name: '切换端口' })
    fireEvent.click(change)
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledWith(expect.objectContaining({
      message: '将 TCP 48764 切换到 TCP 49123？',
    })))
    expect(mocks.invoke.mock.calls.some(([, command]) => command === 'mobile_start')).toBe(false)
    fireEvent.click(change)
    expect(await screen.findByRole('alert')).toHaveTextContent('当前连接仍使用 TCP 48764')
    conflict = false
    fireEvent.click(change)
    expect(await screen.findByText('已切换到 TCP 49123，旧端口 TCP 48764 已关闭。')).toBeVisible()
  })
})
