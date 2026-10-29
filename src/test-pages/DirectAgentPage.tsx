import { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import DirectAgentConnectionPanel from '../components/DirectAgentConnectionPanel'
import ConfirmDialog from '../components/ConfirmDialog'
import { ensureBuiltinLocaleLoaded, useLocaleStore } from '../lib/i18n'
import type { DirectAgentApi, DirectAgentInfo } from '../lib/directAgent'
import type { SshConnection } from '../types'
import '../App.css'

const sshConnections: SshConnection[] = [{ id: 'web-test-ssh', name: 'WinDev', host: '192.168.252.107', port: 22, username: 'Administrator', auth_kind: 'password', host_key_fingerprint: 'SHA256:ssh-fixture', created_at: 1, updated_at: 1 }]

export function DirectAgentAcceptancePage() {
  const [events, setEvents] = useState<string[]>([])
  const [failure, setFailure] = useState('')
  const [provisionPending, setProvisionPending] = useState(false)
  const finishProvision = useRef<(() => void) | null>(null)
  const failureRef = useRef('')
  const serviceRef = useRef<DirectAgentInfo>({ enabled: false, host: '192.168.252.107', port: 48763, certificateFingerprint: 'SHA256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', tokenSaved: true, previousPorts: [49521, 51234] })
  const api = useMemo<DirectAgentApi>(() => ({
    info: async () => ({ ...serviceRef.current }),
    provision: async (_connectionId, port) => {
      setEvents(value => [...value, `provision:${port}`])
      setProvisionPending(true)
      await new Promise<void>(resolve => { finishProvision.current = resolve })
      setProvisionPending(false)
      serviceRef.current = { ...serviceRef.current, port: port ?? 48763 }
      return { ...serviceRef.current }
    },
    probe: async (_host, port) => {
      setEvents(value => [...value, `probe:${port}`])
      if (failureRef.current === 'unreachable') throw new Error('[direct:unreachable]')
      return { certificateFingerprint: serviceRef.current.certificateFingerprint }
    },
    test: async target => {
      setEvents(value => [...value, `authenticate:${target.port}`])
      if (failureRef.current === 'auth') throw new Error('[direct:auth]')
      return { version: 'fixture-1', protocol: 1 }
    },
    save: async target => {
      setEvents(value => [...value, `save:${target.enabled}:${target.port}`])
      serviceRef.current = { ...serviceRef.current, enabled: target.enabled, host: target.host, port: target.port, certificateFingerprint: target.certificateFingerprint }
    },
    firewallPlan: async target => {
      setEvents(value => [...value, `firewall-plan:${target.port}`])
      return {
        host: target.agentHost, sshPort: 22, username: 'Administrator', account: 'WINDEV\\Administrator', port: target.port,
        clientAddress: '192.168.252.10', localAddress: target.agentHost, networkCategory: 'Public', interfaceAlias: 'Ethernet', profiles: ['Public'],
        ruleName: `QingCode-Agent-fixture-${target.port}`, alreadyEnabled: false, canApply: failureRef.current !== 'admin',
        reason: failureRef.current === 'admin' ? '[direct:firewall-admin]' : null,
        planSha256: 'fixture-plan-digest', hostFingerprint: 'SHA256:ssh-fixture',
      }
    },
    firewallApply: async target => {
      setEvents(value => [...value, `firewall-apply:${target.port}`])
      return { changed: true, ruleName: `QingCode-Agent-fixture-${target.port}`, port: target.port, clientAddress: '192.168.252.10', profiles: ['Public'] }
    },
  }), [])

  return <main className="h-full overflow-auto bg-bg p-4 text-fg">
    <h1 className="mb-3 text-ui-lg">Agent 独立端口直连 Web 验收</h1>
    <p className="mb-3 text-ui-sm text-fg-muted">固定内存适配器，不建立真实网络连接、不修改防火墙。</p>
    <div className="mb-4 flex flex-wrap items-center gap-3 text-ui">
      <label>模拟连接结果<select className="ml-2 rounded border border-border bg-bg-elevated p-1" value={failure} onChange={event => { setFailure(event.target.value); failureRef.current = event.target.value }}>
        <option value="">成功</option><option value="unreachable">端口不可达</option><option value="auth">认证失败</option><option value="admin">SSH 无管理员权限</option>
      </select></label>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }}>切换主题</button>
      <button onClick={async () => {
        const language = useLocaleStore.getState().language === 'en' ? 'zh-CN' : 'en'
        await ensureBuiltinLocaleLoaded(language)
        useLocaleStore.getState().setLanguage(language)
      }}>切换语言</button>
    </div>
    {provisionPending && <button className="mb-3" onClick={() => finishProvision.current?.()}>完成模拟服务准备</button>}
    <div className="max-w-[760px] rounded border border-dialog-border bg-dialog p-4">
      <DirectAgentConnectionPanel connectionId="web-test-direct" defaultHost="192.168.252.107" api={api} sshConnections={sshConnections} />
    </div>
    <output className="mt-4 block break-all font-mono text-ui-sm" data-testid="calls">{JSON.stringify(events)}</output>
    <ConfirmDialog />
  </main>
}

if (import.meta.env.MODE === 'web-test') {
  useLocaleStore.getState().setLanguage('zh-CN')
  createRoot(document.getElementById('root')!).render(<DirectAgentAcceptancePage />)
}
