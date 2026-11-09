import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Copy, LoaderCircle, Play, ShieldCheck, CircleCheck, CircleAlert } from 'lucide-react'
import { translate, useI18n } from '../lib/i18n'
import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { hydrateSshSecrets, sshRuntimeConfig, sshSecretsFor } from '../lib/sshWorkspace'
import { useDirectServerManage } from '../hooks/useDirectServerManage'
import DirectSshAuthFields from './DirectSshAuthFields'
import ServerAutoStartSwitch from './ServerAutoStartSwitch'
import Tooltip from './Tooltip'
import type { SshConnection } from '../types'
import {
  directAgentApi,
  directAgentErrorKey,
  directAgentFirewallCommand,
  directAgentFirewallHintKey,
  directAgentSshCandidates,
  isDirectAgentPort,
  parseDirectAgentPairing,
  shortFingerprint,
  validateDirectAgentTarget,
  type DirectAgentApi,
  type DirectAgentFirewallPlatform,
  type DirectAgentInfo,
} from '../lib/directAgent'

const fieldClass = 'mt-1 min-w-0 w-full rounded border border-dialog-border bg-dialog-input px-2.5 py-1.5 text-ui text-fg outline-none focus:border-accent'
const buttonClass = 'rounded border border-dialog-border px-3 py-1.5 text-ui text-fg hover:bg-bg-hover disabled:opacity-40'
const spinClass = 'animate-spin motion-reduce:animate-none'

const FIREWALL_PLATFORMS: readonly { value: DirectAgentFirewallPlatform; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'firewalld', label: 'Linux（firewalld）' },
  { value: 'ufw', label: 'Linux（ufw）' },
  { value: 'macos', label: 'macOS' },
]

type SettingRowId = 'connection' | 'startup' | 'firewall' | 'pairing' | 'ssh'

/** 由父级提供的 SSH 表单；已启用直连时收进「SSH 配置」设置行。 */
export interface DirectAgentSshSection {
  summary: string
  dirty?: boolean
  form: ReactNode
  actions: ReactNode
}

interface Props {
  connectionId: string
  defaultHost: string
  onUpdated?: (info: DirectAgentInfo) => void | Promise<void>
  onDraftStateChange?: (state: { dirty: boolean; busy: boolean }) => void
  initiallyOpen?: boolean
  standalone?: boolean
  sshConnections?: readonly SshConnection[]
  sshSection?: DirectAgentSshSection
  /** Web acceptance reuses the real panel with an explicit in-memory adapter. */
  api?: DirectAgentApi
}

function SettingRow({ id, title, summary, dirty, open, disabled, onToggle, children }: {
  id: SettingRowId
  title: string
  summary: string
  dirty?: boolean
  open: boolean
  disabled?: boolean
  onToggle: (id: SettingRowId) => void
  children: ReactNode
}) {
  const { t } = useI18n()
  const bodyId = `direct-agent-row-${id}`
  return <div className="border-b border-dialog-separator last:border-b-0">
    <button type="button" data-direct-row={id} disabled={disabled} onClick={() => onToggle(id)} aria-expanded={open} aria-controls={open ? bodyId : undefined} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-bg-hover disabled:opacity-40">
      {open ? <ChevronDown size={14} className="shrink-0 text-fg-muted" /> : <ChevronRight size={14} className="shrink-0 text-fg-muted" />}
      <span className="shrink-0 text-ui text-fg">{title}</span>
      <span className={`ml-auto min-w-0 truncate text-ui-sm ${dirty ? 'text-warn' : 'text-fg-muted'}`}>{dirty ? t('有未保存修改') : summary}</span>
    </button>
    {open && <div id={bodyId} className="min-w-0 space-y-3 border-t border-dialog-separator p-3">{children}</div>}
  </div>
}

function StepHeading({ index, children }: { index: number; children: ReactNode }) {
  return <h4 className="flex items-center gap-2 text-ui font-medium text-fg">
    <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-dialog-active text-ui-xs text-fg-muted">{index}</span>
    {children}
  </h4>
}

export default function DirectAgentConnectionPanel({ connectionId, defaultHost, onUpdated, onDraftStateChange, standalone = false, initiallyOpen = false, sshConnections, sshSection, api = directAgentApi }: Props) {
  const { t } = useI18n()
  const storedConnections = useProjectStore(state => state.sshConnections)
  const [open, setOpen] = useState(standalone || initiallyOpen)
  const [info, setInfo] = useState<DirectAgentInfo | null>(null)
  const [host, setHost] = useState(defaultHost)
  const [port, setPort] = useState('48763')
  const [fingerprint, setFingerprint] = useState('')
  const [token, setToken] = useState('')
  const [pairing, setPairing] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [expandedRow, setExpandedRow] = useState<SettingRowId | null>(null)
  const [autoStart, setAutoStart] = useState(true)
  const [busy, setBusy] = useState<'loading' | 'provisioning' | 'testing' | 'saving' | 'firewallPlan' | 'firewallConfirm' | 'firewallApply' | 'firewallProbe' | null>(standalone || initiallyOpen ? 'loading' : null)
  const [sshConnectionId, setSshConnectionId] = useState('')
  const [sshSecretsConnectionId, setSshSecretsConnectionId] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [sshPassphrase, setSshPassphrase] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [startupWarning, setStartupWarning] = useState('')
  const [firewallPlatform, setFirewallPlatform] = useState<DirectAgentFirewallPlatform | ''>('')
  const [firewallPlatformDetected, setFirewallPlatformDetected] = useState(false)
  const firewallPlatformPicked = useRef(false)
  const [activity, setActivity] = useState('')
  const [savingEnabled, setSavingEnabled] = useState(true)
  const [verified, setVerified] = useState<string | null>(null)
  const requestRef = useRef(0)
  const confirmationRef = useRef<AbortController | null>(null)
  const verificationKey = JSON.stringify([host.trim(), port, fingerprint, token])
  const allSshConnections = sshConnections ?? storedConnections
  const candidates = directAgentSshCandidates(allSshConnections, host)
  const sshConnection = candidates.find(connection => connection.id === sshConnectionId) ??
    candidates.find(connection => connection.id === connectionId) ?? candidates[0]
  // 启动 Server 只能用已保存目标的 SSH 连接，草稿主机不得影响它。
  const serverCandidates = directAgentSshCandidates(allSshConnections, info?.host ?? host)
  const serverSsh = serverCandidates.find(connection => connection.id === sshConnectionId) ??
    serverCandidates.find(connection => connection.id === connectionId) ?? serverCandidates[0]
  const firewallApplying = busy === 'firewallApply'
  const firewallSshId = sshConnection?.id
  const secretFor = (connection: SshConnection) => sshSecretsConnectionId === connection.id
    ? (connection.auth_kind === 'password' ? sshPassword : sshPassphrase)
    : ''
  const server = useDirectServerManage({
    connectionId,
    info,
    ssh: serverSsh,
    password: serverSsh?.auth_kind === 'password' ? secretFor(serverSsh) : '',
    passphrase: serverSsh && serverSsh.auth_kind !== 'password' ? secretFor(serverSsh) : '',
    autoStart,
    api,
    onManaged: async value => {
      setSshPassword('')
      setSshPassphrase('')
      setInfo(value)
      await onUpdated?.(value)
    },
  })
  const anyBusy = Boolean(busy) || server.busy
  const connectionDirty = host !== (info?.host || defaultHost) || port !== String(info?.port || 48763) ||
    fingerprint !== (info?.certificateFingerprint || '') || Boolean(token)
  const autoStartDirty = autoStart !== (info?.autoStart ?? true)

  useEffect(() => {
    onDraftStateChange?.({
      dirty: connectionDirty || Boolean(pairing || sshPassword || sshPassphrase) || autoStartDirty,
      // Reads and connection tests can be abandoned; protect remote writes in flight.
      busy: busy === 'saving' || busy === 'provisioning' || busy === 'firewallApply' || server.busy,
    })
  }, [onDraftStateChange, connectionDirty, autoStartDirty, pairing, sshPassword, sshPassphrase, busy, server.busy])

  useEffect(() => {
    if (!open || !api.firewallPlatform) return
    let stale = false
    // 识别失败或没有可用会话时保持未选择，绝不回落到某个默认系统。
    void api.firewallPlatform(connectionId, firewallSshId).then(platform => {
      if (stale || !platform || firewallPlatformPicked.current) return
      setFirewallPlatform(platform)
      setFirewallPlatformDetected(true)
    }).catch(() => {})
    return () => { stale = true }
  }, [api, connectionId, firewallSshId, open])

  const fill = (value: DirectAgentInfo) => {
    setInfo(value)
    setAutoStart(value.autoStart ?? true)
    setHost(value.host || defaultHost)
    setPort(value.port > 0 ? String(value.port) : '48763')
    setFingerprint(value.certificateFingerprint || '')
    setToken('')
    setPairing('')
    setSshPassword('')
    setSshPassphrase('')
    setVerified(null)
  }

  useEffect(() => {
    if (!open) return
    const request = ++requestRef.current
    void api.info(connectionId).then(value => {
      if (request !== requestRef.current) return
      if (value) {
        setInfo(value)
        setAutoStart(value.autoStart ?? true)
        setHost(value.host || defaultHost)
        setPort(value.port > 0 ? String(value.port) : '48763')
        setFingerprint(value.certificateFingerprint || '')
      }
    }).catch(reason => {
      if (request === requestRef.current) setError(translate(directAgentErrorKey(reason)))
    }).finally(() => {
      if (request === requestRef.current) setBusy(null)
    })
    return () => {
      requestRef.current += 1
      confirmationRef.current?.abort()
    }
  }, [api, connectionId, defaultHost, open])

  const invalidate = () => {
    requestRef.current += 1
    confirmationRef.current?.abort()
    setBusy(null)
    setVerified(null)
    setError('')
    setNotice('')
    setStartupWarning('')
  }

  const invalidateFirewall = () => {
    requestRef.current += 1
    confirmationRef.current?.abort()
    setBusy(null)
    setError('')
    setNotice('')
  }

  const toggle = () => {
    invalidate()
    if (!open) setBusy('loading')
    setToken('')
    setPairing('')
    setSshPassword('')
    setSshPassphrase('')
    setOpen(value => !value)
  }

  const toggleRow = (id: SettingRowId) => setExpandedRow(current => current === id ? null : id)

  const provision = async () => {
    const invalid = validateDirectAgentTarget(host, port)
    if (invalid) { setError(t(invalid)); return }
    const request = ++requestRef.current
    setBusy('provisioning')
    setError('')
    setNotice('')
    setStartupWarning('')
    try {
      const result = await api.provision(connectionId, Number(port), autoStart)
      if (request !== requestRef.current) return
      fill(result)
      setStartupWarning(result.startupWarning ?? '')
      setNotice(t('服务已准备。请开放显示的 TCP 端口，再测试直连。'))
    } catch (reason) {
      if (request === requestRef.current) setError(t(directAgentErrorKey(reason)))
    } finally {
      if (request === requestRef.current) setBusy(null)
    }
  }

  const importPairing = () => {
    try {
      const value = parseDirectAgentPairing(pairing)
      invalidate()
      setSshPassword('')
      setSshPassphrase('')
      if (value.host && value.host !== '0.0.0.0' && value.host !== '::') setHost(value.host)
      setPort(String(value.port))
      setFingerprint(value.certificateFingerprint)
      setToken(value.token)
      setPairing('')
      setManualOpen(false)
      // 已启用时接着要测试并保存，直接带用户到连接行。
      setExpandedRow('connection')
      setNotice(t('配对信息已导入。请测试连接并核对服务器身份。'))
    } catch {
      setError(t('配对信息格式无效，请粘贴服务端输出的配对 JSON。'))
    }
  }

  const test = async () => {
    const invalid = validateDirectAgentTarget(host, port)
    if (invalid) { setError(t(invalid)); return }
    if (!token && !info?.tokenSaved) { setError(t('请先安装服务或导入配对信息。')); return }
    const request = ++requestRef.current
    setActivity(t('正在检查 Server 端口和服务器证书…'))
    setBusy('testing')
    setError('')
    setNotice('')
    setVerified(null)
    try {
      // Observe only the certificate first. Credentials are sent after explicit identity confirmation.
      const observed = await api.probe(host.trim(), Number(port))
      if (request !== requestRef.current) return
      const trusted = info?.enabled && info.host === host.trim() && info.port === Number(port) &&
        info.certificateFingerprint === observed.certificateFingerprint
      if (!trusted || fingerprint !== observed.certificateFingerprint) {
        const controller = new AbortController()
        confirmationRef.current = controller
        setActivity(t('等待确认服务器身份…'))
        const accepted = await confirmDialog({
          title: t('确认 Server 服务器身份'),
          message: t('请将此指纹与远端配对信息核对。确认后才会发送认证凭据。'),
          detail: fingerprint && fingerprint !== observed.certificateFingerprint
            ? `${t('原指纹')}\n${fingerprint}\n\n${t('当前指纹')}\n${observed.certificateFingerprint}`
            : observed.certificateFingerprint,
          kind: 'warning',
          confirmLabel: t('信任此服务器'),
          cancelLabel: t('取消'),
          signal: controller.signal,
        })
        if (request !== requestRef.current) return
        if (!accepted) { setNotice(t('已取消直连测试，未发送认证凭据。')); return }
      }
      setActivity(t('正在验证 Server 认证凭据…'))
      const target = { connectionId, host: host.trim(), port: Number(port), certificateFingerprint: observed.certificateFingerprint, token: token || undefined }
      const result = await api.test(target)
      if (request !== requestRef.current) return
      setFingerprint(observed.certificateFingerprint)
      setVerified(JSON.stringify([host.trim(), port, observed.certificateFingerprint, token]))
      setNotice(t('直连测试成功（服务 {version}）。可以保存并启用。', { version: result.version }))
    } catch (reason) {
      if (request === requestRef.current) setError(t(directAgentErrorKey(reason)))
    } finally {
      if (request === requestRef.current) setBusy(null)
    }
  }

  const save = async (enabled: boolean) => {
    if (enabled && verified !== verificationKey) return
    if (!enabled && !info) return
    const request = ++requestRef.current
    setSavingEnabled(enabled)
    setBusy('saving')
    setNotice('')
    setError('')
    try {
      const target = enabled
        ? { connectionId, host: host.trim(), port: Number(port), certificateFingerprint: fingerprint, token: token || undefined, enabled }
        : { connectionId, host: info!.host, port: info!.port, certificateFingerprint: info!.certificateFingerprint, enabled }
      await api.save(target)
      if (request !== requestRef.current) return
      const previousPorts = [...new Set([...(info?.previousPorts ?? []), ...(info?.port && info.port !== target.port ? [info.port] : [])])].filter(value => value !== target.port)
      const saved = { ...target, autoStart: info?.autoStart, tokenSaved: enabled ? true : info!.tokenSaved, previousPorts }
      await onUpdated?.(saved)
      if (request !== requestRef.current) return
      fill(saved)
      setToken('')
      setVerified(null)
      setNotice(t(enabled ? '已启用 Server 端口直连。' : '已恢复使用 SSH 连接。'))
    } catch (reason) {
      if (request === requestRef.current) setError(t(directAgentErrorKey(reason)))
    } finally {
      if (request === requestRef.current) setBusy(null)
    }
  }

  const authorizeFirewall = async () => {
    const invalid = validateDirectAgentTarget(host, port)
    if (invalid) { setError(t(invalid)); return }
    if (!sshConnection || !api.firewallPlan || !api.firewallApply) return
    const request = ++requestRef.current
    setBusy('firewallPlan')
    setError('')
    setNotice('')
    try {
      // 应用重启后内存里没有凭据，需先载入本机加密保存的密码或口令。
      await hydrateSshSecrets(sshConnection.id)
      if (request !== requestRef.current) return
      const target = {
        connectionId, sshConnectionId: sshConnection.id, agentHost: host.trim(), port: Number(port),
        config: sshRuntimeConfig(sshConnection, {
          ...sshSecretsFor(sshConnection.id),
          ...(sshSecretsConnectionId === sshConnection.id && sshPassword ? { password: sshPassword } : {}),
          ...(sshSecretsConnectionId === sshConnection.id && sshPassphrase ? { passphrase: sshPassphrase } : {}),
        }),
      }
      const plan = await api.firewallPlan(target)
      if (request !== requestRef.current) return
      if (!plan.canApply) {
        setError(plan.reason ? t(directAgentErrorKey(plan.reason)) : t('此 SSH 账户无法放行该端口，请检查远端管理员权限。'))
        return
      }
      if (!plan.alreadyEnabled) {
        const controller = new AbortController()
        confirmationRef.current = controller
        setBusy('firewallConfirm')
        const accepted = await confirmDialog({
          title: t('授权通过 SSH 放行端口'),
          message: t(plan.profiles.includes('Public')
            ? '当前 SSH 接口使用公用网络。仅授权当前客户端访问所示 TCP 端口；不会放行其他来源、修改 SSH 或清理历史端口规则。'
            : '仅授权当前客户端访问所示 TCP 端口和网络范围。不会放行其他来源、修改 SSH 或清理历史端口规则。'),
          detail: t('SSH：{username}@{host}:{sshPort}\n执行账户：{account}\n接收地址：{localAddress}\nTCP 端口：{port}\n允许来源：{source}\n网络范围：{profiles}\n网络接口：{interfaceAlias}（{networkCategory}）\n规则：{rule}', {
            username: plan.username, host: plan.host, sshPort: plan.sshPort, account: plan.account, port: plan.port, source: plan.clientAddress, localAddress: plan.localAddress, profiles: plan.profiles.join(', '), interfaceAlias: plan.interfaceAlias, networkCategory: plan.networkCategory, rule: plan.ruleName,
          }),
          kind: 'warning', confirmLabel: t('授权放行'), cancelLabel: t('取消'), signal: controller.signal,
        })
        if (request !== requestRef.current) return
        if (!accepted) { setNotice(t('已取消端口放行，未修改防火墙。')); return }
        setBusy('firewallApply')
        await api.firewallApply({ ...target, expectedPlanSha256: plan.planSha256 })
        if (request !== requestRef.current) return
      }
      setSshPassword('')
      setSshPassphrase('')
      setBusy('firewallProbe')
      // The probe sends no Server credentials and grants no certificate trust.
      try {
        const observed = await api.probe(target.agentHost, target.port)
        if (request !== requestRef.current) return
        setNotice(t(fingerprint && fingerprint !== observed.certificateFingerprint
          ? '防火墙规则已写入，但 Server 证书与配对信息不一致。请测试直连并核对服务器身份。'
          : '防火墙规则已写入，Server 端口可达。请测试直连并核对服务器身份。'))
      } catch {
        if (request === requestRef.current) setNotice(t('防火墙规则已写入，但 Server 连接尚未验证。请检查服务监听、网关映射和其他防火墙，再测试直连。'))
      }
    } catch (reason) {
      if (request === requestRef.current) setError(t(directAgentErrorKey(reason)))
    } finally {
      if (request === requestRef.current) setBusy(null)
    }
  }

  const runServerAction = async (start: boolean) => {
    setError('')
    setNotice('')
    setStartupWarning('')
    const outcome = await server.manage(start)
    if (!outcome) return
    if (outcome.warning) {
      setAutoStart(false)
      setStartupWarning(outcome.warning)
    }
    if (outcome.error) {
      setError(t(outcome.error))
      // 失败多半要改 SSH 授权或自启，展开对应设置行。
      setExpandedRow('startup')
    } else if (outcome.notice) {
      setNotice(t(outcome.notice))
    }
  }

  const copyFingerprint = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setError('')
      setNotice(t('已复制证书指纹'))
    }).catch(() => setError(t('复制失败，请手动复制指纹。')))
  }

  const renderSshAuth = (connection: SshConnection, list: readonly SshConnection[]) => <DirectSshAuthFields
    candidates={list}
    connection={connection}
    secret={secretFor(connection)}
    disabled={firewallApplying || server.busy}
    onSelect={id => { invalidateFirewall(); setSshConnectionId(id); setSshPassword(''); setSshPassphrase('') }}
    onSecretChange={value => {
      invalidateFirewall()
      setSshSecretsConnectionId(connection.id)
      if (connection.auth_kind === 'password') setSshPassword(value)
      else setSshPassphrase(value)
    }}
  />

  const validPort = isDirectAgentPort(Number(port))
  const verifiedNow = verified === verificationKey
  const firewallCommand = firewallPlatform ? directAgentFirewallCommand(Number(port), firewallPlatform) : null
  const firewallButtonLabel = busy === 'firewallConfirm' ? t('等待确认端口放行…')
    : busy === 'firewallPlan' ? t('正在检查 SSH 权限…')
    : busy === 'firewallApply' ? t('正在放行端口…')
      : busy === 'firewallProbe' ? t('正在检查端口可达性…') : t('通过 SSH 授权放行')

  const busyLabel = server.busy ? t('正在通过 SSH 管理 Server…')
    : busy === 'loading' ? t('正在读取 Server 配置…')
    : busy === 'provisioning' ? t('正在通过 SSH 准备 Server 服务，请稍候…')
      : busy === 'testing' ? activity
        : busy === 'saving' ? t(savingEnabled ? '正在保存并启用 Server 直连…' : '正在恢复 SSH 连接…')
          : busy ? firewallButtonLabel : ''
  const feedback = busyLabel || error || notice
  const managedInfo = open && info?.enabled ? info : null
  // 自动打开的面板读取期间也隐藏标题，避免已启用的连接闪一下折叠头。
  const headerless = Boolean(managedInfo) || (busy === 'loading' && (standalone || initiallyOpen))

  const testButton = <button type="button" disabled={Boolean(busy)} onClick={() => void test()} aria-busy={busy === 'testing'} className={`${buttonClass} inline-flex items-center gap-2`}>{busy === 'testing' && <LoaderCircle size={14} className={spinClass} aria-hidden="true" />}{t(busy === 'testing' ? '正在测试直连…' : '测试直连')}</button>
  const saveButton = <button type="button" disabled={Boolean(busy) || !verifiedNow} onClick={() => void save(true)} aria-busy={busy === 'saving' && savingEnabled} className="inline-flex items-center gap-2 rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-40">{busy === 'saving' && savingEnabled && <LoaderCircle size={14} className={spinClass} aria-hidden="true" />}{t(busy === 'saving' && savingEnabled ? '正在保存并启用…' : '保存并启用直连')}</button>
  const verifyHint = !verifiedNow && !anyBusy && <span className="text-ui-sm text-fg-muted">{t('测试通过后才能保存并启用。')}</span>

  const pairingForm = <>
    <p className="text-ui-sm text-fg-muted">{t('也可在远端手动启动服务，将 direct-info --include-secret 输出的配对 JSON 粘贴到此处。配对信息包含凭据，请勿分享。')}</p>
    <code className="block break-all rounded bg-dialog-input p-2 font-mono text-ui-sm text-fg">qingcode-server direct --hostname 0.0.0.0 --port {validPort ? Number(port) : 48763}<br />qingcode-server startup {autoStart ? 'enable' : 'disable'}<br />qingcode-server direct-info --include-secret</code>
    <label className="block text-ui-sm text-dialog-label">{t('配对 JSON')}<textarea value={pairing} onChange={event => setPairing(event.target.value)} spellCheck={false} autoComplete="off" rows={3} className={`${fieldClass} font-mono`} /></label>
    <button type="button" disabled={Boolean(busy) || !pairing.trim()} onClick={importPairing} className={buttonClass}>{t('应用配对信息')}</button>
  </>

  const connectionFields = <>
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
      <label className="text-ui-sm text-dialog-label">{t('Server 主机')}<input disabled={firewallApplying} value={host} onChange={event => { invalidate(); setHost(event.target.value); setSshPassword(''); setSshPassphrase('') }} autoComplete="off" className={fieldClass} /></label>
      <label className="text-ui-sm text-dialog-label">{t('TCP 端口')}<input disabled={firewallApplying} value={port} onChange={event => { invalidate(); setPort(event.target.value) }} inputMode="numeric" className={fieldClass} /></label>
    </div>
    <p className="text-ui-sm text-fg-muted">{t('此处填写客户端连接的目标端口。修改已有服务的端口时，须同步修改远端监听配置并重新开放对应端口。')}</p>
    {Boolean(info?.previousPorts?.length) && <div className="rounded border border-dialog-border bg-dialog-sidebar p-2 text-ui-sm text-fg-muted">
      <p>{t('历史端口：{ports}', { ports: info!.previousPorts.join('、') })}</p>
      <p className="mt-1">{t('历史端口仅供核对，不会自动回退。确认旧端口不再使用后，请清理对应的防火墙规则。')}</p>
    </div>}
    <label className="block text-ui-sm text-dialog-label">{t('Server 认证凭据')}<input disabled={firewallApplying} type="password" value={token} onChange={event => { invalidate(); setToken(event.target.value) }} autoComplete="new-password" placeholder={info?.tokenSaved ? t('已安全保存，留空继续使用') : t('从配对信息导入或填写')} className={fieldClass} /></label>
    {fingerprint && <div className="rounded border border-dialog-border bg-dialog-input p-2 text-ui-sm"><p className="mb-1 flex items-center gap-1 text-fg-muted"><ShieldCheck size={13} />{t('服务器证书指纹')}</p><p className="break-all font-mono text-fg">{fingerprint}</p></div>}
  </>

  const firewallBody = <div className="grid grid-cols-1 items-start gap-3 text-ui-sm @min-[48rem]/direct-agent:grid-cols-2">
    <div className="min-w-0 space-y-2">
      <p className="text-fg-muted">{t('可通过 SSH 检查并授权放行此端口（仅支持 Windows 远端）；执行前会显示允许来源和网络范围。跨网络时还需配置网关或端口映射。')}</p>
      <label className="block text-dialog-label">{t('远端系统')}<select value={firewallPlatform} onChange={event => { firewallPlatformPicked.current = true; setFirewallPlatformDetected(false); setFirewallPlatform(event.target.value as DirectAgentFirewallPlatform | '') }} className={fieldClass}>
        <option value="">{t('请选择')}</option>
        {FIREWALL_PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      {firewallPlatformDetected && <p className="text-fg-muted">{t('已根据 SSH 连接自动识别，可手动修改。')}</p>}
      {firewallPlatform && <p className="text-fg-muted">{t(directAgentFirewallHintKey(firewallPlatform))}</p>}
      {firewallCommand && <>
        <code className="block break-all rounded bg-dialog-input p-2 font-mono text-fg">{firewallCommand}</code>
        <button type="button" onClick={() => void navigator.clipboard.writeText(firewallCommand).then(() => setNotice(t('已复制防火墙命令'))).catch(() => setError(t('复制失败，请手动复制命令。')))} className={`${buttonClass} inline-flex items-center gap-1`}><Copy size={13} />{t('复制防火墙命令')}</button>
      </>}
    </div>
    {api.firewallPlan && api.firewallApply && <div className="min-w-0 space-y-2 rounded border border-dialog-border bg-dialog-sidebar p-2.5">
      {sshConnection ? <>
        {renderSshAuth(sshConnection, candidates)}
        <p className="break-all text-fg-muted">{t('SSH 授权仅用于配置远端防火墙，日常 Server 通信继续使用独立端口。')}</p>
        <button type="button" disabled={anyBusy} onClick={() => void authorizeFirewall()} className={`${buttonClass} inline-flex items-center gap-1`}>{busy?.startsWith('firewall') ? <LoaderCircle size={13} className={spinClass} aria-hidden="true" /> : <ShieldCheck size={13} />}{firewallButtonLabel}</button>
      </> : <p className="text-fg-muted">{t('未找到此主机的 SSH 连接。请先在远程连接中添加并确认 SSH 主机指纹，或使用下方命令手动放行。')}</p>}
    </div>}
  </div>

  const renderSshRow = (saved: DirectAgentInfo | null) => <SettingRow id="ssh" title={t('SSH 配置')} summary={sshSection?.summary ?? t('可切回 SSH')} dirty={sshSection?.dirty} open={expandedRow === 'ssh'} disabled={firewallApplying} onToggle={toggleRow}>
    {sshSection?.form}
    <div className="flex flex-wrap items-center gap-2">
      {saved && <button type="button" disabled={anyBusy} onClick={() => void save(false)} aria-busy={busy === 'saving' && !savingEnabled} className={`${buttonClass} inline-flex items-center gap-2`}>{busy === 'saving' && !savingEnabled && <LoaderCircle size={14} className={spinClass} aria-hidden="true" />}{t(busy === 'saving' && !savingEnabled ? '正在恢复 SSH 连接…' : '恢复 SSH 连接')}</button>}
      {sshSection?.actions && <div className="ml-auto flex flex-wrap items-center gap-2">{sshSection.actions}</div>}
    </div>
  </SettingRow>

  const managedView = managedInfo && <>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-dialog-border bg-dialog-sidebar p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-ui text-fg">
          <span className="break-all font-mono">{managedInfo.host}:{managedInfo.port}</span>
          <span className="rounded bg-dialog-active px-1.5 text-ui-xs text-fg-muted">TLS</span>
        </p>
        {managedInfo.certificateFingerprint && <p className="flex items-center gap-1 text-ui-sm text-fg-muted">
          <ShieldCheck size={13} className="shrink-0" aria-hidden="true" />
          {t('指纹')}
          <span className="font-mono text-fg">{shortFingerprint(managedInfo.certificateFingerprint)}</span>
          <Tooltip label={t('复制证书指纹')}>
            <button type="button" aria-label={t('复制证书指纹')} onClick={() => copyFingerprint(managedInfo.certificateFingerprint)} className="rounded p-0.5 hover:bg-bg-hover hover:text-fg"><Copy size={12} /></button>
          </Tooltip>
        </p>}
      </div>
      {serverSsh && api.manage && <button type="button" disabled={anyBusy} onClick={() => void runServerAction(true)} className={`${buttonClass} inline-flex items-center gap-1.5`}>{server.busy ? <LoaderCircle size={13} className={spinClass} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}{t('通过 SSH 启动 Server')}</button>}
    </div>

    <div className="rounded border border-dialog-border">
      <SettingRow id="connection" title={t('连接地址与凭据')} summary={`${managedInfo.host}:${managedInfo.port} · ${t(managedInfo.tokenSaved ? '凭据已保存' : '未保存凭据')}`} dirty={connectionDirty} open={expandedRow === 'connection'} disabled={firewallApplying} onToggle={toggleRow}>
        {connectionFields}
        <div className="flex flex-wrap items-center gap-2">
          {testButton}
          {(connectionDirty || verifiedNow) && saveButton}
          {connectionDirty && verifyHint}
        </div>
      </SettingRow>
      <SettingRow id="startup" title={t('启动与开机自启')} summary={t(autoStart ? '开机自启已开启' : '开机自启已关闭')} dirty={autoStartDirty} open={expandedRow === 'startup'} disabled={firewallApplying} onToggle={toggleRow}>
        <ServerAutoStartSwitch checked={autoStart} disabled={anyBusy} onChange={setAutoStart} />
        <p className="text-ui-sm text-fg-muted">{t('默认开启。通过 SSH 应用设置；关闭只取消开机自启，不停止当前服务。')}</p>
        {serverSsh && api.manage ? <>
          <div className="grid min-w-0 grid-cols-1 gap-3 @min-[32rem]/direct-agent:grid-cols-2">{renderSshAuth(serverSsh, serverCandidates)}</div>
          <button type="button" disabled={anyBusy} onClick={() => void runServerAction(false)} className={buttonClass}>{t('应用自启设置')}</button>
        </> : <>
          <p className="text-ui-sm text-fg-muted">{t('未找到此主机的 SSH 连接。可配置 SSH 后启动，或在远端手动运行以下命令。')}</p>
          <button type="button" onClick={() => useUIStore.getState().openRemoteConnections()} className={buttonClass}>{t('配置 SSH 连接')}</button>
        </>}
        <details className="text-ui-sm text-fg-muted"><summary className="cursor-pointer">{t('远端手动启动命令')}</summary>
          <p className="my-2">{t('使用原安装账户和原 Server 程序运行，保留配对信息。Windows 自启需管理员权限，Linux 需 systemd。')}</p>
          <code className="block whitespace-pre-wrap break-all rounded bg-dialog-input p-2 font-mono">{`qingcode-server direct --port ${managedInfo.port} --detach\nqingcode-server startup ${autoStart ? 'enable' : 'disable'}`}</code>
        </details>
      </SettingRow>
      {validPort && <SettingRow id="firewall" title={t('端口放行')} summary={[`TCP ${port}`, FIREWALL_PLATFORMS.find(item => item.value === firewallPlatform)?.label].filter(Boolean).join(' · ')} open={expandedRow === 'firewall'} disabled={firewallApplying} onToggle={toggleRow}>
        {firewallBody}
      </SettingRow>}
      <SettingRow id="pairing" title={t('重新配对')} summary={t('导入新的配对信息')} dirty={Boolean(pairing)} open={expandedRow === 'pairing'} disabled={firewallApplying} onToggle={toggleRow}>
        {pairingForm}
      </SettingRow>
      {!standalone && renderSshRow(managedInfo)}
    </div>
  </>

  const setupView = <>
    <div className="space-y-3">
      <StepHeading index={1}>{t('准备服务')}</StepHeading>
      <ServerAutoStartSwitch checked={autoStart} disabled={Boolean(busy)} onChange={setAutoStart} />
      <div className="flex flex-wrap items-center gap-2">
        {!standalone && <button type="button" disabled={Boolean(busy)} onClick={() => void provision()} aria-busy={busy === 'provisioning'} className={`${buttonClass} inline-flex items-center gap-2`}>{busy === 'provisioning' && <LoaderCircle size={14} className={spinClass} aria-hidden="true" />}{t(busy === 'provisioning' ? '正在准备服务…' : '通过 SSH 安装或读取服务')}</button>}
        <button type="button" disabled={Boolean(busy)} onClick={() => setManualOpen(value => !value)} aria-expanded={manualOpen} className={buttonClass}>{t('导入配对信息')}</button>
      </div>
      {manualOpen && <div className="space-y-2 rounded border border-dialog-border bg-dialog-sidebar p-3">{pairingForm}</div>}
    </div>
    <div className="space-y-3">
      <StepHeading index={2}>{t('连接目标')}</StepHeading>
      {connectionFields}
    </div>
    {validPort && <div className="space-y-3">
      <StepHeading index={3}>{t('放行端口')}</StepHeading>
      <details className="rounded border border-warn/40 bg-warn/5 text-ui-sm">
        <summary className="cursor-pointer px-3 py-2 font-medium text-warn">{t('远端需要开放 TCP {port}', { port })}</summary>
        <div className="border-t border-warn/20 p-3">{firewallBody}</div>
      </details>
    </div>}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-dialog-separator bg-dialog py-3">
      {testButton}
      {saveButton}
      {verifyHint}
    </div>
    {sshSection && <div className="rounded border border-dialog-border">{renderSshRow(null)}</div>}
  </>

  return (
    <section className={`@container/direct-agent ${headerless ? '' : 'rounded border border-dialog-border'}`} aria-label={t('Server 端口直连')}>
      {!headerless && <button type="button" disabled={firewallApplying} onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui font-medium text-fg hover:bg-bg-hover disabled:opacity-40">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('Server 端口直连')}
      </button>}
      {open && <fieldset disabled={busy === 'saving' || server.busy} className={`min-w-0 space-y-3 border-0 ${headerless ? 'p-0' : 'border-t border-dialog-separator p-3'}`}>
        {!managedInfo && <p className="text-ui-sm leading-relaxed text-fg-muted">{t(standalone ? '通过独立 TLS 端口连接远端服务，无需 SSH。请先在远端启动服务，再导入配对信息。' : '通过独立 TLS 端口连接远端服务，通信不经过 SSH。现有 SSH 配置保留，可随时切回。')}</p>}
        {feedback && <div role={error && !anyBusy ? 'alert' : 'status'} aria-live={error && !anyBusy ? 'assertive' : 'polite'} aria-atomic="true" className={`sticky top-0 z-10 flex items-start gap-2 rounded border p-3 text-ui-sm shadow-sm ${anyBusy ? 'border-accent/40 bg-dialog text-fg' : error ? 'border-danger/40 bg-dialog text-danger' : 'border-ok/40 bg-dialog text-fg'}`}>
          {/* 图标占一整行行高并居中，字号缩放后仍与首行文字对齐。 */}
          <span className="flex h-[1lh] shrink-0 items-center">
            {anyBusy ? <LoaderCircle size={16} className={`${spinClass} text-accent`} aria-hidden="true" /> : error ? <CircleAlert size={16} aria-hidden="true" /> : <CircleCheck size={16} className="text-ok" aria-hidden="true" />}
          </span>
          <span className="min-w-0 break-words">{feedback}</span>
        </div>}
        {startupWarning && !anyBusy && <p role="status" className="break-words rounded border border-warn/40 bg-warn/5 p-3 text-ui-sm text-fg">{t(managedInfo ? '未能配置开机自启，已将其关闭，远端重启后需手动启动。原因：{reason}' : '服务已可用，但未能配置开机自启，已将其关闭，远端重启后需手动启动。原因：{reason}', { reason: startupWarning })}</p>}
        {busy !== 'loading' && (managedView || setupView)}
      </fieldset>}
    </section>
  )
}
