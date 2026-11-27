// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/backendApi'
import { useTargets } from '../store/targets'
import { TargetForm } from './TargetForm'
import type { Checkbox, Modal } from './ui'

vi.mock('../lib/cn', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }))
vi.mock('./primitives', () => ({ Select: () => null }))
vi.mock('./ui', () => ({
  Modal: ({ title, description, children, footer }: ComponentProps<typeof Modal>) => (
    <section><h1>{title}</h1>{description}{children}{footer}</section>
  ),
  Checkbox: ({ checked, onChange, children, disabled }: ComponentProps<typeof Checkbox>) => (
    <label><input type="checkbox" checked={checked} disabled={disabled}
      onChange={(event) => onChange(event.target.checked)} />{children}</label>
  ),
  ErrorNote: ({ message }: { message: ReactNode }) => message,
  IconButton: () => null,
}))

const ssh: SshTarget = {
  id: 'remote', kind: 'ssh', name: '远程', host: 'host', port: 22, username: 'root', auth: { kind: 'password' },
}
const withDirect: SshTarget = {
  ...ssh, direct: { host: 'host', port: 47390, fingerprint: 'ab'.repeat(32), grantId: 'grant' },
}

describe('SSH 直连加速确认', () => {
  const original = useTargets.getState()
  const save = vi.fn()
  const test = vi.fn()
  const enableDirect = vi.fn()
  const onSaved = vi.fn()
  const onClose = vi.fn()
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.resetAllMocks()
    save.mockResolvedValue(ssh)
    test.mockResolvedValue({ os: 'Linux', nodeVersion: '26' })
    enableDirect.mockResolvedValue(withDirect)
    useTargets.setState({ save, test, enableDirect, notice: null })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(() => root.unmount())
    host.remove()
    useTargets.setState(original)
    vi.unstubAllGlobals()
  })

  const render = (initial?: SshTarget) => act(() => root.render(
    <TargetForm initial={initial} onSaved={onSaved} onClose={onClose} />,
  ))
  const click = (label: string) => act(() => {
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
    expect(button).toBeDefined()
    button?.click()
  })
  const fill = (selector: string, value: string) => act(() => {
    const input = host.querySelector<HTMLInputElement>(selector)
    expect(input).not.toBeNull()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const autoDirect = () => Array.from(host.querySelectorAll('label'))
    .find((label) => label.textContent?.trim() === '开启直连加速')?.querySelector('input')

  it('新 SSH 默认勾选，测试通过后等待确认，确认后用直连配置连接', async () => {
    await render()
    expect(autoDirect()?.checked).toBe(true)
    await fill('[placeholder="主机"]', ssh.host)
    await fill('[type="password"]', 'test-password')
    await click('保存')

    expect(test).toHaveBeenCalledWith(expect.objectContaining({ id: ssh.id }), { password: 'test-password', remember: true })
    expect(host.textContent).toContain('确认开启直连加速')
    expect(enableDirect).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()

    await click('确认并开启')
    expect(enableDirect).toHaveBeenCalledExactlyOnceWith({ id: ssh.id, reuseListener: true, password: 'test-password' })
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(withDirect, { password: 'test-password', remember: true })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('可在首次确认时跳过直连并完成 SSH 连接', async () => {
    await render()
    await fill('[placeholder="主机"]', ssh.host)
    await click('保存')
    await click('仅使用 SSH')

    expect(enableDirect).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(ssh, { remember: true })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('从新建表单取消勾选时直接完成 SSH 连接', async () => {
    await render()
    await fill('[placeholder="主机"]', ssh.host)
    await act(() => autoDirect()?.click())
    await click('保存')

    expect(host.textContent).not.toContain('确认开启直连加速')
    expect(enableDirect).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(ssh, { remember: true })
  })

  it('自动配置失败时给出提示并继续 SSH 连接', async () => {
    enableDirect.mockRejectedValue(new Error('端口已被占用'))
    await render()
    await fill('[placeholder="主机"]', ssh.host)
    await click('保存')
    await click('确认并开启')

    expect(useTargets.getState().notice).toContain('端口已被占用')
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(ssh, { remember: true })
  })

  it('SSH 测试失败时保留表单，等待重试', async () => {
    test.mockRejectedValue(new Error('认证失败'))
    await render()
    await fill('[placeholder="主机"]', ssh.host)
    await click('保存')

    expect(host.textContent).toContain('配置已保存，但连接测试失败')
    expect(host.textContent).not.toContain('确认开启直连加速')
    expect(enableDirect).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('编辑已有连接时可确认手动开启，并直接显示开启状态', async () => {
    await render(ssh)
    await click('开启直连加速')
    expect(enableDirect).not.toHaveBeenCalled()
    await click('确认并开启')

    expect(enableDirect).toHaveBeenCalledExactlyOnceWith({ id: ssh.id, listen: '47390', host: ssh.host, allowPublic: false })
    expect(host.textContent).toContain('关闭直连加速')
    expect(onSaved).not.toHaveBeenCalled()
  })
})
