import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Copy, Eye, EyeOff, Plus, QrCode, RotateCw, ShieldCheck, Smartphone, Trash2, Wifi } from 'lucide-react'
import { call } from '../lib/backend'
import {
  buildAddressOptions,
  buildSettingsPatch,
  draftFromSettings,
  formatDeviceTime,
  gatewayStatus,
  groupFingerprint,
  isValidPairingCode,
  normalizePublicAddress,
  parsePort,
  type SettingsDraft,
} from '../lib/mobileSettings'
import { useMobile } from '../store/mobile'
import { FeedbackRow } from './FeedbackRow'
import { FormField } from './FormField'
import { Select, TabsContent, TabsList, TabsRoot, TabsTrigger } from './primitives'
import { Badge, Checkbox, EmptyState, ErrorNote, IconButton, Spinner } from './ui'

function Section({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-ui font-medium text-qn-text">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function MobileSettings() {
  const settings = useMobile((s) => s.settings)
  const devices = useMobile((s) => s.devices)
  const busy = useMobile((s) => s.busy)
  const error = useMobile((s) => s.error)
  const notice = useMobile((s) => s.notice)
  const manualCopy = useMobile((s) => s.manualCopy)
  const load = useMobile((s) => s.load)
  const save = useMobile((s) => s.save)
  const retry = useMobile((s) => s.retry)
  const copyInfo = useMobile((s) => s.copyInfo)
  const revoke = useMobile((s) => s.revoke)
  const regenerate = useMobile((s) => s.regenerate)
  const dismissError = useMobile((s) => s.dismissError)
  const dismissNotice = useMobile((s) => s.dismissNotice)
  const clearManualCopy = useMobile((s) => s.clearManualCopy)

  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [addressInput, setAddressInput] = useState('')
  const [selectedAddress, setSelectedAddress] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [tab, setTab] = useState('settings')
  const [pairQr, setPairQr] = useState<{ address: string; rows: string[] } | null>(null)
  const [loadingQr, setLoadingQr] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => setPairQr(null), [settings?.fingerprint])

  // 离开设置分类时清理含配对密码的连接信息。
  useEffect(() => () => useMobile.getState().clearManualCopy(), [])

  // 只在首次拿到设置时初始化草稿，刷新状态不覆盖尚未保存的编辑。
  useEffect(() => {
    if (settings && !draft) setDraft(draftFromSettings(settings))
  }, [settings, draft])

  const options = useMemo(
    () => buildAddressOptions(settings?.lanAddresses ?? [], settings?.publicAddresses ?? []),
    [settings],
  )
  const lanOptions = options.filter((option) => option.kind === 'lan')
  const publicOptions = options.filter((option) => option.kind === 'public')
  const address = options.some((option) => option.value === selectedAddress)
    ? selectedAddress
    : (options[0]?.value ?? '')

  const patchResult = draft && settings ? buildSettingsPatch(draft, settings) : null
  const dirty = patchResult !== null && (!patchResult.ok || Object.keys(patchResult.patch).length > 0)
  const portError = draft && parsePort(draft.port) === null ? '端口需为 1–65535 的整数' : null
  const passwordError =
    draft?.password && !isValidPairingCode(draft.password) ? '配对密码需为 6–20 位且不含空白字符' : null
  const status = gatewayStatus(settings)

  const patch = (part: Partial<SettingsDraft>) => setDraft((value) => (value ? { ...value, ...part } : value))

  async function showQr() {
    if (loadingQr || !address) return
    setLoadingQr(true)
    setFormError(null)
    try {
      const result = await call('mobile.pairQr', { address })
      setPairQr({ address, rows: result.rows })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '二维码生成失败')
    } finally {
      setLoadingQr(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft || !settings) return
    const result = buildSettingsPatch(draft, settings)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setFormError(null)
    setPairQr(null)
    const next = await save(result.patch)
    if (next) {
      setDraft(draftFromSettings(next))
      setAddressInput('')
    }
  }

  const addAddress = () => {
    if (!draft) return
    const normalized = normalizePublicAddress(addressInput)
    if (!normalized) {
      setFormError('对外地址需为有效的 host:port，例如 frp.example.com:7001')
      return
    }
    if (draft.publicAddresses.includes(normalized)) {
      setFormError('该地址已在列表中')
      return
    }
    setDraft({ ...draft, publicAddresses: [...draft.publicAddresses, normalized] })
    setAddressInput('')
    setFormError(null)
  }

  const removeAddress = (index: number) => {
    if (!draft) return
    patch({ publicAddresses: draft.publicAddresses.filter((_, i) => i !== index) })
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-qn-border bg-qn-panel px-3 py-2">
        <Smartphone size={16} className="shrink-0 text-qn-accent" />
        <span className="text-ui">手机网关</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="font-mono text-ui-sm text-qn-muted">0.0.0.0:{settings?.port ?? 38500}</span>
        <span className="min-w-0 flex-1" />
        {busy && <Spinner label={busy} />}
        <IconButton label="刷新状态" className="h-7 w-7" disabled={busy !== null} onClick={() => void load()}>
          <RotateCw size={14} />
        </IconButton>
      </div>
      <div className="space-y-2">
        {status.detail && <p className="text-ui-sm text-qn-muted">{status.detail}</p>}
        {settings?.error && <ErrorNote message={settings.error} onRetry={() => void retry()} />}
        <ErrorNote message={error} onClose={dismissError} />
        <ErrorNote message={formError} onClose={() => setFormError(null)} />
        <FeedbackRow
          message={notice}
          className="rounded-lg border border-qn-border bg-qn-warn/10 px-3 py-2 text-ui leading-5 text-qn-warn"
          onClose={dismissNotice}
        />
      </div>

      <form onSubmit={(event) => void submit(event)}>
        <TabsRoot value={tab} onValueChange={setTab}>
          <TabsList aria-label="手机连接设置" className="mb-4 mt-2 border-b border-qn-border pb-2">
            <TabsTrigger value="settings">连接设置</TabsTrigger>
            <TabsTrigger value="addresses">连接地址</TabsTrigger>
            <TabsTrigger value="devices">已配对设备（{devices.length}）</TabsTrigger>
            <TabsTrigger value="security">安全</TabsTrigger>
          </TabsList>

          <TabsContent value="settings" className="space-y-4">
            <Checkbox checked={draft?.enabled ?? false} onChange={(value) => patch({ enabled: value })}>
              启用手机连接（关闭后手机无法连接这台电脑）
            </Checkbox>
            <Checkbox checked={draft?.terminalEnabled ?? false} onChange={(value) => patch({ terminalEnabled: value })}>
              允许本人已配对的手机在项目中打开终端
            </Checkbox>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_1fr]">
              <FormField label="监听端口" hint="端口修改后，可在手机端编辑已保存的连接。" error={portError}>
                {(control) => (
                  <input
                    {...control}
                    className="qn-input"
                    inputMode="numeric"
                    value={draft?.port ?? ''}
                    onChange={(event) => patch({ port: event.target.value })}
                  />
                )}
              </FormField>
              <FormField label="配对密码" hint="6–20 位、区分大小写；用本机系统加密保存，不会写进日志。" error={passwordError}>
                {(control) => (
                  <div className="flex gap-1.5">
                    <input
                      {...control}
                      className="qn-input min-w-0 flex-1"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="off"
                      placeholder={settings?.hasPassword ? '已设置，留空表示不修改' : '6–20 位，区分大小写'}
                      value={draft?.password ?? ''}
                      onChange={(event) => patch({ password: event.target.value })}
                    />
                    <IconButton
                      label={showPassword ? '隐藏配对密码' : '显示配对密码'}
                      className="h-[36px] w-[36px]"
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </IconButton>
                  </div>
                )}
              </FormField>
            </div>
            <Section title="导入到手机" action={
              <button type="button" className="text-ui-sm text-qn-accent hover:underline" onClick={() => setTab('addresses')}>
                管理地址
              </button>
            }>
              <div className="flex gap-2">
                <Select
                  aria-label="连接地址"
                  className="min-w-0 flex-1"
                  value={address}
                  disabled={options.length === 0}
                  placeholder="（暂无可用的连接地址）"
                  onValueChange={(value) => { setSelectedAddress(value); setPairQr(null) }}
                  groups={[
                    { label: '局域网地址', options: lanOptions.map((option) => ({ value: option.value, label: option.value })) },
                    { label: '对外地址', options: publicOptions.map((option) => ({ value: option.value, label: option.value })) },
                  ].filter((group) => group.options.length > 0)}
                />
                <button
                  className="qn-button flex shrink-0 items-center gap-1.5"
                  type="button"
                  disabled={!address || !settings?.hasPassword || dirty || busy !== null}
                  onClick={() => void copyInfo(address)}
                >
                  <Copy size={14} /> 复制连接信息
                </button>
                <IconButton label="显示配对二维码" disabled={!address || !settings?.hasPassword || dirty || busy !== null || loadingQr}
                  onClick={() => { if (pairQr) setPairQr(null); else void showQr() }}>
                  <QrCode size={16} />
                </IconButton>
              </div>
              <p className="text-ui-sm text-qn-muted">
                {dirty || !settings?.hasPassword
                  ? '请先保存配对设置，再复制连接信息。'
                  : '在手机版选择「从剪贴板导入」。信息含配对密码，请只发给自己。'}
              </p>
              {pairQr?.address === address && !dirty && (
                <div className="space-y-2">
                  <svg role="img" aria-label="手机配对二维码" viewBox={`-4 -4 ${pairQr.rows.length + 8} ${pairQr.rows.length + 8}`}
                    className="h-52 w-52 bg-white" shapeRendering="crispEdges">
                    <path fill="#000" d={pairQr.rows.map((row, y) => Array.from(row, (module, x) => module === '1' ? `M${x} ${y}h1v1h-1z` : '').join('')).join('')} />
                  </svg>
                  <p className="text-ui-sm text-qn-muted">二维码含配对密码，请用自己的手机扫描。</p>
                </div>
              )}
              {manualCopy && (
                <div className="space-y-1.5">
                  <textarea
                    aria-label="可手动复制的连接信息"
                    className="qn-input h-24 resize-none font-mono text-ui-sm"
                    readOnly
                    value={manualCopy}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button className="qn-button-subtle px-2.5 py-1 text-ui-sm" type="button" onClick={clearManualCopy}>
                    收起
                  </button>
                </div>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="addresses" className="space-y-5">
            <Section
              title={
                <>
                  <Wifi size={14} /> 局域网地址 <span className="font-normal text-qn-dim">自动检测</span>
                </>
              }
            >
              {lanOptions.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {lanOptions.map((option) => (
                    <li key={option.value} className="rounded-md bg-qn-fg/[0.05] px-2 py-1 font-mono text-ui-sm">
                      {option.value}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-ui-sm text-qn-muted">未检测到局域网 IPv4，可改用下面的对外地址。</div>
              )}
            </Section>

            <Section title="对外地址" action={<span className="font-mono text-ui-sm text-qn-dim">host:port</span>}>
              {draft && draft.publicAddresses.length > 0 && (
                <ul className="space-y-1">
                  {draft.publicAddresses.map((value, index) => (
                    <li key={`${value}-${index}`} className="flex items-center gap-2 rounded-lg bg-qn-fg/[0.04] py-0.5 pl-3 pr-1">
                      <span className="min-w-0 flex-1 truncate font-mono text-ui-sm">{value}</span>
                      <IconButton label="删除对外地址" danger className="h-7 w-7" onClick={() => removeAddress(index)}>
                        <Trash2 size={14} />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <input
                  className="qn-input min-w-0 flex-1"
                  aria-label="对外地址"
                  placeholder="frp.example.com:7001"
                  value={addressInput}
                  onChange={(event) => {
                    setAddressInput(event.target.value)
                    setFormError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addAddress()
                    }
                  }}
                />
                <button className="qn-button-subtle flex shrink-0 items-center gap-1" type="button" onClick={addAddress}>
                  <Plus size={14} /> 添加
                </button>
              </div>
              <p className="text-ui-sm text-qn-dim">frp / 端口转发等公网地址，填手机实际访问的地址和端口；保存后生效。</p>
            </Section>
          </TabsContent>

          <TabsContent value="devices">
            <Section
              title={`已配对设备（${devices.length}）`}
              action={
                <IconButton label="刷新设备列表" className="h-7 w-7" disabled={busy !== null} onClick={() => void load()}>
                  <RotateCw size={14} />
                </IconButton>
              }
            >
              {devices.length === 0 ? (
                <EmptyState>还没有配对设备。到「连接设置」复制连接信息，再从手机版粘贴导入。</EmptyState>
              ) : (
                <ul className="space-y-1.5">
                  {devices.map((device) => (
                    <li key={device.id} className="flex items-center gap-3 rounded-lg bg-qn-fg/[0.04] px-3 py-2">
                      <Smartphone size={16} className="shrink-0 text-qn-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-ui">{device.name}</div>
                        <div className="truncate text-ui-sm text-qn-dim">
                          配对 {formatDeviceTime(device.pairedAt)} · 最近在线 {formatDeviceTime(device.lastSeenAt)} ·{' '}
                          {device.lastIp || '未知 IP'}
                        </div>
                      </div>
                      <button
                        className="qn-button-subtle shrink-0 px-2.5 py-1 text-ui-sm text-qn-danger"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void revoke(device.id)}
                      >
                        撤销
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="security">
            <Section
              title={
                <>
                  <ShieldCheck size={15} /> 证书指纹（SHA-256）
                </>
              }
              action={
                <button
                  className="qn-button-subtle px-2.5 py-1 text-ui-sm"
                  type="button"
                  disabled={busy !== null || confirmRegen}
                  onClick={() => setConfirmRegen(true)}
                >
                  重新生成
                </button>
              }
            >
              <div className="break-all rounded-lg bg-qn-fg/[0.04] px-3 py-2 font-mono text-ui-sm leading-5 text-qn-muted">
                {settings?.fingerprint ? groupFingerprint(settings.fingerprint) : '尚未生成'}
              </div>
              <p className="text-ui-sm text-qn-dim">手机首次连接时会核对该指纹，防止中间人冒充这台电脑。</p>
              {confirmRegen && (
                <div className="space-y-2 rounded-lg border border-qn-border bg-qn-danger/10 p-3 text-ui">
                  <p>重新生成会更换证书指纹并解除所有已配对设备，已保存的手机连接将失效，须从电脑重新复制连接信息。</p>
                  <div className="flex gap-2">
                    <button
                      className="qn-button px-3 py-1 text-ui-sm"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirmRegen(false)
                        void regenerate()
                      }}
                    >
                      确认重新生成
                    </button>
                    <button className="qn-button-subtle px-3 py-1 text-ui-sm" type="button" onClick={() => setConfirmRegen(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </Section>
          </TabsContent>
        </TabsRoot>
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-qn-border pt-4">
          <span className="text-ui-sm text-qn-muted" role="status">
            {dirty ? '有未保存的修改' : '电脑需保持运行，手机才能连接。'}
          </span>
          <button className="qn-button shrink-0" type="submit" disabled={!draft || busy !== null}>
            保存设置
          </button>
        </div>
      </form>
    </div>
  )
}
