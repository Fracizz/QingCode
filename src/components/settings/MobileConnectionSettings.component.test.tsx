// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileConnectionSettings from './MobileConnectionSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), choose: vi.fn() }))

vi.mock('@/lib/tauri', () => ({ isTauri: () => true, safeInvoke: mocks.invoke }))
vi.mock('@/store/choiceStore', () => ({ choiceDialog: mocks.choose }))

const fingerprint = 'ab'.repeat(32)
const qr = { size: 21, modules: '1'.repeat(21 * 21) }

function status(port: number | null, overrides: Record<string, unknown> = {}) {
  return {
    port,
    savedPort: port ?? 48764,
    configured: port !== null,
    enabled: port !== null,
    fingerprint: port === null ? null : fingerprint,
    devices: [],
    addresses: port === null ? [] : ['192.168.1.8', '10.0.0.5'],
    computer: 'DEVBOX',
    error: null,
    ...overrides,
  }
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
      if (command === 'mobile_pairing_qr') return Promise.resolve(qr)
      return new Promise(resolve => { complete = value => { current = value; resolve(value) } })
    })
    render(<MobileConnectionSettings />)
    const save = screen.getByRole('button', { name: '保存并启用' })
    await waitFor(() => expect(save).toBeEnabled())
    expect(screen.queryByRole('textbox', { name: /IPv4/ })).toBeNull()
    fireEvent.click(save)
    expect(screen.getByRole('alert')).toHaveTextContent('请输入 6–20 位密码')
    fireEvent.change(screen.getByLabelText('移动连接密码'), { target: { value: '123456' } })
    fireEvent.click(save)
    expect(screen.getByRole('status')).toHaveTextContent('正在保存并检查端口')
    expect(mocks.invoke).toHaveBeenCalledWith('保存移动连接', 'mobile_start', { port: 48764, code: '123456' })
    complete(status(48764))
    expect(await screen.findByText(/之后启动 QingCode 时会自动启用/)).toBeVisible()
    expect(screen.getByLabelText('移动连接密码')).toHaveValue('123456')
    fireEvent.click(screen.getByRole('button', { name: '显示密码' }))
    expect(screen.getByLabelText('移动连接密码')).toHaveAttribute('type', 'text')
  })

  it('shows a pairing QR for the selected address and copies the pairing link', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    mocks.invoke.mockImplementation((_label, command) => {
      if (command === 'mobile_saved_settings') return Promise.resolve({ port: 48764, configured: true, password: 'abcdef' })
      if (command === 'mobile_status') return Promise.resolve(status(48764))
      if (command === 'mobile_pairing_qr') return Promise.resolve(qr)
      return Promise.reject(new Error('unexpected'))
    })
    render(<MobileConnectionSettings />)
    expect(await screen.findByRole('img', { name: 'Android 配对二维码' })).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('生成配对二维码', 'mobile_pairing_qr', {
      text: `qingcode://pair?v=1&host=192.168.1.8&port=48764&fp=${fingerprint}&name=DEVBOX`,
    })
    fireEvent.change(screen.getByLabelText('配对使用的电脑地址'), { target: { value: '10.0.0.5' } })
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('生成配对二维码', 'mobile_pairing_qr', {
      text: expect.stringContaining('host=10.0.0.5'),
    }))
    fireEvent.click(screen.getByRole('button', { name: '复制配对链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('host=10.0.0.5&port=48764')))
    expect(screen.getByText(/abab abab/)).not.toBeVisible()
    fireEvent.click(screen.getByText('手动核对证书指纹'))
    expect(screen.getByText(/abab abab/)).toBeVisible()
    // The password never goes into the QR code or the pairing link.
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('abcdef'))
  })

  it('lists paired phones and revokes one after confirmation', async () => {
    let devices = [
      { id: 'd1', name: 'Pixel 8', pairedAt: 1_790_000_000, online: true },
      { id: 'd2', name: 'Galaxy Tab', pairedAt: 1_780_000_000, online: false },
    ]
    mocks.choose.mockResolvedValueOnce('cancel').mockResolvedValue('revoke')
    mocks.invoke.mockImplementation((_label, command, args) => {
      if (command === 'mobile_saved_settings') return Promise.resolve({ port: 48764, configured: true, password: null })
      if (command === 'mobile_status') return Promise.resolve(status(48764, { devices }))
      if (command === 'mobile_pairing_qr') return Promise.resolve(qr)
      if (command === 'mobile_revoke_device') {
        devices = devices.filter(device => device.id !== args.id)
        return Promise.resolve(status(48764, { devices }))
      }
      return Promise.reject(new Error('unexpected'))
    })
    render(<MobileConnectionSettings />)
    expect(await screen.findByText('已配对的手机（2/8）')).toBeVisible()
    expect(screen.getByText(/1 台手机在线/)).toBeVisible()
    const remove = screen.getByRole('button', { name: '移除 Galaxy Tab' })
    fireEvent.click(remove)
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledTimes(1))
    expect(mocks.invoke.mock.calls.some(([, command]) => command === 'mobile_revoke_device')).toBe(false)
    fireEvent.click(remove)
    expect(await screen.findByText('已移除 Galaxy Tab。')).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('移除移动设备', 'mobile_revoke_device', { id: 'd2' })
    expect(screen.queryByText('Galaxy Tab')).toBeNull()
  })

  it('reports an automatic start failure from the backend', async () => {
    mocks.invoke.mockImplementation((_label, command) => {
      if (command === 'mobile_saved_settings') return Promise.resolve({ port: 48764, configured: true, password: null })
      if (command === 'mobile_status') {
        return Promise.resolve(status(null, { configured: true, enabled: true, error: '自动启用失败：无法监听端口 48764' }))
      }
      return Promise.reject(new Error('unexpected'))
    })
    render(<MobileConnectionSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('自动启用失败')
    expect(screen.getByLabelText('移动连接密码')).toHaveAttribute('placeholder', '留空沿用已保存密码')
  })

  it('confirms a switch, retains the active port on failure, and reports the released port on success', async () => {
    let current = status(48764)
    let conflict = true
    mocks.choose.mockResolvedValueOnce('cancel').mockResolvedValue('switch')
    mocks.invoke.mockImplementation((_label, command) => {
      if (command === 'mobile_saved_settings') return Promise.resolve({ port: 48764, configured: true })
      if (command === 'mobile_status') return Promise.resolve(current)
      if (command === 'mobile_pairing_qr') return Promise.resolve(qr)
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

  it.each(['abcdef', '!!!!!!', '12345678901234567890'])('accepts a simple password %s', async password => {
    mocks.invoke.mockImplementation((_label, command) => Promise.resolve(command === 'mobile_saved_settings'
      ? { port: 48764, configured: false, password: null }
      : command === 'mobile_pairing_qr' ? qr : status(command === 'mobile_start' ? 48764 : null)))
    render(<MobileConnectionSettings />)
    const save = screen.getByRole('button', { name: '保存并启用' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.change(screen.getByLabelText('移动连接密码'), { target: { value: password } })
    fireEvent.click(save)
    expect(await screen.findByText(/已保存并启用移动连接/)).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('保存移动连接', 'mobile_start', { port: 48764, code: password })
  })

  it.each(['12345', '123456789012345678901', 'abc 12'])('rejects an invalid password %s', async password => {
    mocks.invoke.mockImplementation((_label, command) => Promise.resolve(command === 'mobile_saved_settings'
      ? { port: 48764, configured: false, password: null } : status(null)))
    render(<MobileConnectionSettings />)
    const save = screen.getByRole('button', { name: '保存并启用' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.change(screen.getByLabelText('移动连接密码'), { target: { value: password } })
    fireEvent.click(save)
    expect(screen.getByRole('alert')).toHaveTextContent('请输入 6–20 位密码')
    expect(mocks.invoke.mock.calls.some(([, command]) => command === 'mobile_start')).toBe(false)
  })

  it('restores and reveals the saved password, stops with auto-start disabled, and reuses it', async () => {
    let current = status(48765)
    mocks.invoke.mockImplementation((_label, command) => {
      if (command === 'mobile_saved_settings') return Promise.resolve({ port: 48765, configured: true, password: 'abcdef' })
      if (command === 'mobile_pairing_qr') return Promise.resolve(qr)
      if (command === 'mobile_stop') current = status(null, { configured: true })
      if (command === 'mobile_start') current = status(48765)
      return Promise.resolve(current)
    })
    render(<MobileConnectionSettings />)
    const field = screen.getByLabelText('移动连接密码')
    await waitFor(() => expect(field).toHaveValue('abcdef'))
    expect(await screen.findByText(/已启用 · TCP 48765/)).toBeVisible()
    expect(field).toBeDisabled()
    expect(field).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getByRole('button', { name: '显示密码' }))
    expect(field).toHaveAttribute('type', 'text')
    fireEvent.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(field).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getByRole('button', { name: '停止连接' }))
    expect(await screen.findByText(/已配对的手机会保留/)).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('停止移动连接', 'mobile_stop', { disable: true })
    await waitFor(() => expect(field).toBeEnabled())
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))
    expect(mocks.invoke).toHaveBeenCalledWith('保存移动连接', 'mobile_start', { port: 48765, code: null })
    await waitFor(() => expect(field).toHaveValue('abcdef'))
  })

  it('reuses a legacy verifier when no recoverable password is available', async () => {
    mocks.invoke.mockImplementation((_label, command) => Promise.resolve(command === 'mobile_saved_settings'
      ? { port: 48764, configured: true }
      : command === 'mobile_pairing_qr' ? qr : status(command === 'mobile_start' ? 48764 : null)))
    render(<MobileConnectionSettings />)
    const save = screen.getByRole('button', { name: '保存并启用' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    expect(await screen.findByText(/已保存并启用移动连接/)).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('保存移动连接', 'mobile_start', { port: 48764, code: null })
  })
})
