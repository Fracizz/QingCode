// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DirectAgentConnectionPanel from './DirectAgentConnectionPanel'
import type { DirectAgentApi, DirectAgentFirewallPlan, DirectAgentInfo } from '../lib/directAgent'
import type { SshConnection } from '../types'

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('../store/confirmStore', () => ({ confirmDialog: confirm }))

const info: DirectAgentInfo = { enabled: false, host: '192.168.252.107', port: 48763, certificateFingerprint: 'SHA256:server', tokenSaved: true, previousPorts: [] }
const ssh: SshConnection = { id: 'ssh-win', name: 'WinDev', host: info.host, port: 22, username: 'Administrator', auth_kind: 'password', host_key_fingerprint: 'SHA256:ssh', created_at: 1, updated_at: 1 }
const firewallPlan: DirectAgentFirewallPlan = { host: info.host, sshPort: 22, username: ssh.username, account: 'WINDEV\\Administrator', port: 48763, clientAddress: '192.168.252.10', localAddress: info.host, networkCategory: 'Public', interfaceAlias: 'Ethernet', profiles: ['Public'], ruleName: 'QingCode-owned-fixture', alreadyEnabled: false, canApply: true, reason: null, planSha256: 'plan-digest', hostFingerprint: ssh.host_key_fingerprint }

function apiMock(saved: DirectAgentInfo | null = info): DirectAgentApi {
  return {
    info: vi.fn().mockResolvedValue(saved),
    provision: vi.fn().mockResolvedValue(info),
    probe: vi.fn().mockResolvedValue({ certificateFingerprint: info.certificateFingerprint }),
    test: vi.fn().mockResolvedValue({ version: '0.1.test', protocol: 1 }),
    save: vi.fn().mockResolvedValue(undefined),
  }
}

async function openPanel(api: DirectAgentApi, sshConnections: SshConnection[] = []) {
  render(<DirectAgentConnectionPanel connectionId="c1" defaultHost="192.168.252.107" api={api} sshConnections={sshConnections} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agent 端口直连' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '测试直连' })).not.toBeDisabled())
}

describe('direct Agent connection panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confirm.mockResolvedValue(true)
    localStorage.clear()
  })

  it('shows a spinner while provisioning and restores the button after failure', async () => {
    const api = apiMock(null)
    let reject!: (reason: Error) => void
    vi.mocked(api.provision).mockReturnValue(new Promise((_, fail) => { reject = fail }))
    await openPanel(api)
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 安装或读取服务' }))
    const button = screen.getByRole('button', { name: '正在准备服务…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button.querySelector('svg')).toHaveClass('animate-spin')
    await act(async () => { reject(new Error('failed')) })
    expect(screen.getByRole('button', { name: '通过 SSH 安装或读取服务' })).not.toBeDisabled()
    expect(screen.getByRole('alert')).toBeVisible()
  })

  it('keeps native requests lazy and uses an editable fixed default port', async () => {
    const api = apiMock(null)
    render(<DirectAgentConnectionPanel connectionId="c1" defaultHost="192.168.252.107" api={api} />)
    expect(api.info).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Agent 端口直连' }))
    await screen.findByDisplayValue('48763')
    expect(screen.getByRole('button', { name: '保存并启用直连' })).toBeDisabled()
    expect(screen.getByText('远端需要开放 TCP 48763')).toBeVisible()
    expect(screen.getByText(/执行前会显示允许来源和网络范围/)).toBeVisible()
    fireEvent.change(screen.getByLabelText('TCP 端口'), { target: { value: '51234' } })
    expect(screen.getByText('远端需要开放 TCP 51234')).toBeVisible()
  })

  it('does not send credentials before the first certificate confirmation', async () => {
    const api = apiMock()
    let answer!: (value: boolean) => void
    confirm.mockReturnValue(new Promise<boolean>(resolve => { answer = resolve }))
    await openPanel(api)
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(api.test).not.toHaveBeenCalled()
    await act(async () => { answer(false) })
    expect(api.test).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '保存并启用直连' })).toBeDisabled()
  })

  it('requires successful authenticated verification before saving and invalidates it when the port changes', async () => {
    const api = apiMock()
    await openPanel(api)
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并启用直连' })).not.toBeDisabled())
    expect(api.test).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1', port: 48763, certificateFingerprint: 'SHA256:server' }))
    fireEvent.change(screen.getByLabelText('TCP 端口'), { target: { value: '51234' } })
    expect(screen.getByRole('button', { name: '保存并启用直连' })).toBeDisabled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('discards a certificate probe that finishes after editing the target', async () => {
    const api = apiMock()
    let finish!: (value: { certificateFingerprint: string }) => void
    vi.mocked(api.probe).mockReturnValue(new Promise(resolve => { finish = resolve }))
    await openPanel(api)
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    fireEvent.change(screen.getByLabelText('Agent 主机'), { target: { value: 'other.test' } })
    await act(async () => { finish({ certificateFingerprint: 'SHA256:old-target' }) })
    expect(confirm).not.toHaveBeenCalled()
    expect(api.test).not.toHaveBeenCalled()
  })

  it('imports credentials transiently, confirms changed identity and clears credentials after save', async () => {
    const api = apiMock(null)
    await openPanel(api)
    fireEvent.click(screen.getByRole('button', { name: '导入配对信息' }))
    fireEvent.change(screen.getByLabelText('配对 JSON'), { target: { value: JSON.stringify({ port: 51234, certificateFingerprint: 'SHA256:expected', token: 'transient-test-token' }) } })
    fireEvent.click(screen.getByRole('button', { name: '应用配对信息' }))
    expect(screen.queryByLabelText('配对 JSON')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并启用直连' })).not.toBeDisabled())
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('SHA256:expected') }))
    expect(api.test).toHaveBeenCalledWith(expect.objectContaining({ port: 51234, token: 'transient-test-token', certificateFingerprint: 'SHA256:server' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并启用直连' }))
    await waitFor(() => expect(screen.getByLabelText('Agent 认证凭据')).toHaveValue(''))
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, token: 'transient-test-token' }))
    expect(localStorage.length).toBe(0)
  })

  it('shows distinct port and authorization errors without raw sensitive native output', async () => {
    const api = apiMock()
    vi.mocked(api.probe).mockRejectedValue('[direct:unreachable] token=hidden')
    await openPanel(api)
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('开放显示的 TCP 端口')
    expect(screen.getByRole('alert')).not.toHaveTextContent('hidden')
    vi.mocked(api.probe).mockResolvedValue({ certificateFingerprint: info.certificateFingerprint })
    vi.mocked(api.test).mockRejectedValue('[direct:auth] token=hidden')
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('认证失败'))
  })

  it('shows historical ports without falling back or overwriting the active target on disable', async () => {
    const api = apiMock({ ...info, enabled: true, previousPorts: [50001, 50002] })
    await openPanel(api)
    expect(screen.getByText('历史端口：50001、50002')).toBeVisible()
    expect(screen.getByText(/历史端口仅供核对，不会自动回退/)).toBeVisible()
    fireEvent.change(screen.getByLabelText('TCP 端口'), { target: { value: 'bad-port' } })
    fireEvent.click(screen.getByRole('button', { name: '恢复 SSH 连接' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ port: 48763, enabled: false })))
  })

  it('keeps verification and transient credentials for retry when the local connection row cannot be saved', async () => {
    const api = apiMock()
    render(<DirectAgentConnectionPanel connectionId="c1" defaultHost="192.168.252.107" api={api} onUpdated={async () => { throw new Error('[direct:record] disk full') }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent 端口直连' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '测试直连' })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Agent 认证凭据'), { target: { value: 'transient-retry-token' } })
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并启用直连' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '保存并启用直连' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('本机连接记录保存失败')
    expect(screen.getByLabelText('Agent 认证凭据')).toHaveValue('transient-retry-token')
    expect(screen.getByRole('button', { name: '保存并启用直连' })).not.toBeDisabled()
    expect(localStorage.length).toBe(0)
  })

  it('checks SSH permissions and confirms exact Public network scope before allowing a port', async () => {
    const api = { ...apiMock(), firewallPlan: vi.fn().mockResolvedValue(firewallPlan), firewallApply: vi.fn().mockResolvedValue({ changed: true }) }
    let answer!: (value: boolean) => void
    confirm.mockReturnValue(new Promise<boolean>(resolve => { answer = resolve }))
    await openPanel(api, [ssh])
    fireEvent.change(screen.getByLabelText('SSH 密码'), { target: { value: 'transient-ssh-password' } })
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(api.firewallApply).not.toHaveBeenCalled()
    expect(api.firewallPlan).toHaveBeenCalledWith(expect.objectContaining({ sshConnectionId: ssh.id, agentHost: info.host, config: expect.objectContaining({ password: 'transient-ssh-password', hostKeyFingerprint: ssh.host_key_fingerprint }) }))
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('公用网络'), detail: expect.stringContaining('允许来源：192.168.252.10') }))
    expect(confirm.mock.calls[0][0].detail).toContain('接收地址：192.168.252.107')
    expect(confirm.mock.calls[0][0].detail).toContain('网络范围：Public')
    await act(async () => { answer(true) })
    await waitFor(() => expect(api.firewallApply).toHaveBeenCalledWith(expect.objectContaining({ expectedPlanSha256: 'plan-digest' })))
    expect(await screen.findByRole('status')).toHaveTextContent('Agent 端口可达')
    expect(screen.getByLabelText('SSH 密码')).toHaveValue('')
    expect(api.test).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '保存并启用直连' })).toBeDisabled()
    expect(localStorage.length).toBe(0)
  })

  it('does not mutate the firewall after canceling authorization or editing a pending target', async () => {
    const api = { ...apiMock(), firewallPlan: vi.fn().mockResolvedValue(firewallPlan), firewallApply: vi.fn() }
    confirm.mockResolvedValueOnce(false)
    await openPanel(api, [ssh])
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '通过 SSH 授权放行' })).not.toBeDisabled())
    expect(api.firewallApply).not.toHaveBeenCalled()
    let answer!: (value: boolean) => void
    confirm.mockReturnValue(new Promise<boolean>(resolve => { answer = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2))
    fireEvent.change(screen.getByLabelText('TCP 端口'), { target: { value: '51234' } })
    await act(async () => { answer(true) })
    expect(api.firewallApply).not.toHaveBeenCalled()
    expect(api.probe).not.toHaveBeenCalled()
  })

  it('does not silently select SSH credentials from another host', async () => {
    const api = { ...apiMock(), firewallPlan: vi.fn(), firewallApply: vi.fn() }
    await openPanel(api, [{ ...ssh, host: 'other.test' }])
    expect(screen.queryByRole('button', { name: '通过 SSH 授权放行' })).toBeNull()
    expect(screen.getByText(/未找到此主机的 SSH 连接/)).toBeVisible()
    expect(screen.getByRole('button', { name: '复制防火墙命令' })).toBeVisible()
    expect(api.firewallPlan).not.toHaveBeenCalled()
  })

  it('clears manually entered SSH credentials when switching Agent hosts', async () => {
    const api = { ...apiMock(), firewallPlan: vi.fn().mockResolvedValue({ ...firewallPlan, alreadyEnabled: true }), firewallApply: vi.fn() }
    await openPanel(api, [ssh, { ...ssh, id: 'other-ssh', host: 'other.test' }])
    fireEvent.change(screen.getByLabelText('SSH 密码'), { target: { value: 'first-host-secret' } })
    fireEvent.change(screen.getByLabelText('Agent 主机'), { target: { value: 'other.test' } })
    expect(screen.getByLabelText('SSH 密码')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    await waitFor(() => expect(api.firewallPlan).toHaveBeenCalled())
    expect(api.firewallPlan.mock.calls[0][0].config.password).toBeUndefined()
    expect(api.firewallApply).not.toHaveBeenCalled()
  })

  it('locks target editing during the mutation and skips mutation for an existing exact rule', async () => {
    let finish!: (value: { changed: boolean }) => void
    const api = { ...apiMock(), firewallPlan: vi.fn().mockResolvedValue(firewallPlan), firewallApply: vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve })) }
    await openPanel(api, [ssh])
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    await waitFor(() => expect(api.firewallApply).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('TCP 端口')).toBeDisabled()
    expect(screen.getByLabelText('Agent 主机')).toBeDisabled()
    expect(screen.getByLabelText('SSH 授权连接')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Agent 端口直连' })).toBeDisabled()
    await act(async () => { finish({ changed: true }) })
    await waitFor(() => expect(screen.getByLabelText('TCP 端口')).not.toBeDisabled())
    api.firewallPlan.mockResolvedValue({ ...firewallPlan, alreadyEnabled: true })
    confirm.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    await waitFor(() => expect(api.firewallPlan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: '通过 SSH 授权放行' })).not.toBeDisabled())
    expect(confirm).not.toHaveBeenCalled()
    expect(api.firewallApply).toHaveBeenCalledTimes(1)
  })

  it('reports insufficient SSH permissions and unreachable Agent separately from successful rule changes', async () => {
    const api = { ...apiMock(), firewallPlan: vi.fn().mockResolvedValue({ ...firewallPlan, canApply: false, reason: '[direct:firewall-admin] secret' }), firewallApply: vi.fn().mockResolvedValue({ changed: true }) }
    await openPanel(api, [ssh])
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没有修改防火墙的权限')
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret')
    expect(confirm).not.toHaveBeenCalled()
    expect(api.firewallApply).not.toHaveBeenCalled()
    api.firewallPlan.mockResolvedValue(firewallPlan)
    vi.mocked(api.probe).mockRejectedValue(new Error('[direct:unreachable]'))
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 授权放行' }))
    expect(await screen.findByRole('status')).toHaveTextContent('防火墙规则已写入，但 Agent 连接尚未验证')
    expect(api.firewallApply).toHaveBeenCalledTimes(1)
  })
})
