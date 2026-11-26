import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Copy,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
  X,
} from 'lucide-react'
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
import { Badge, Checkbox, EmptyState, ErrorNote, IconButton, Modal, Spinner } from './ui'

export function MobileSettingsDialog({ onClose }: { onClose: () => void }) {
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

  useEffect(() => {
    void load()
  }, [load])

  // 手动复制的明文含配对密码，关闭面板后不再留在内存里。
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
  const dirty = patchResult?.ok === true && Object.keys(patchResult.patch).length > 0
  const portError = draft && parsePort(draft.port) === null ? '端口需为 1–65535 的整数' : null
  const passwordError =
    draft?.password && !isValidPairingCode(draft.password)
      ? '配对密码需为 6–20 位且不含空白字符'
      : null
  const status = gatewayStatus(settings)

  const patch = (part: Partial<SettingsDraft>) =>
    setDraft((value) => (value ? { ...value, ...part } : value))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft || !settings) return
    const result = buildSettingsPatch(draft, settings)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setFormError(null)
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
    <Modal
      title="手机连接"
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-qn-muted">电脑需保持运行，手机才能连接。</span>
          <div className="flex shrink-0 gap-2">
            <button className="qn-button-subtle" type="button" onClick={onClose}>
              关闭
            </button>
            <button
              className="qn-button"
              type="submit"
              form="mobile-settings-form"
              disabled={!draft || busy !== null}
            >
              保存设置
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded border border-qn-border bg-black/20 px-3 py-2">
          <Smartphone size={15} className="shrink-0 text-qn-accent" />
          <span className="text-xs">手机网关</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="font-mono text-[11px] text-qn-muted">
            0.0.0.0:{settings?.port ?? 38500}
          </span>
          <span className="min-w-0 flex-1" />
          <button
            className="qn-button-subtle flex items-center gap-1 px-2 py-1 text-[11px]"
            type="button"
            disabled={busy !== null}
            onClick={() => void load()}
          >
            <RefreshCw size={12} /> 刷新状态
          </button>
        </div>
        {status.detail && <p className="text-[11px] text-qn-muted">{status.detail}</p>}
        {settings?.error && <ErrorNote message={settings.error} onRetry={() => void retry()} />}
        <ErrorNote message={error} onClose={dismissError} />
        {notice && (
          <div className="flex items-start gap-2 rounded border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{notice}</span>
            <button type="button" aria-label="关闭提示" onClick={dismissNotice}>
              <X size={13} />
            </button>
          </div>
        )}
        {busy && <Spinner label={busy} />}

        <form id="mobile-settings-form" className="space-y-3" onSubmit={(event) => void submit(event)}>
          <div className="space-y-3 rounded border border-qn-border p-3">
            <Checkbox
              checked={draft?.enabled ?? false}
              onChange={(value) => patch({ enabled: value })}
            >
              启用手机连接（关闭后手机无法连接这台电脑）
            </Checkbox>

            <div>
              <div className="mb-1 text-xs text-qn-muted">监听端口</div>
              <input
                className="qn-input w-28"
                inputMode="numeric"
                value={draft?.port ?? ''}
                onChange={(event) => patch({ port: event.target.value })}
              />
              <p className="mt-1 text-[11px] leading-5 text-qn-muted">
                HTTPS 监听 0.0.0.0 上的该端口；修改后需重新复制连接信息给手机。
              </p>
              {portError && <p className="text-[11px] text-qn-danger">{portError}</p>}
            </div>

            <div>
              <div className="mb-1 text-xs text-qn-muted">配对密码</div>
              <div className="flex gap-2">
                <input
                  className="qn-input min-w-0 flex-1"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="off"
                  placeholder={settings?.hasPassword ? '已设置，留空表示不修改' : '6–20 位，区分大小写'}
                  value={draft?.password ?? ''}
                  onChange={(event) => patch({ password: event.target.value })}
                />
                <IconButton
                  label={showPassword ? '隐藏配对密码' : '显示配对密码'}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </IconButton>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-qn-muted">
                6–20 位、区分大小写；用本机系统加密保存，不会写进日志。
              </p>
              {passwordError && <p className="text-[11px] text-qn-danger">{passwordError}</p>}
            </div>
          </div>

          <div className="space-y-2 rounded border border-qn-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">对外地址</span>
              <span className="font-mono text-[11px] text-qn-muted">host:port</span>
            </div>
            {draft && draft.publicAddresses.length > 0 ? (
              <ul className="space-y-1">
                {draft.publicAddresses.map((value, index) => (
                  <li
                    key={`${value}-${index}`}
                    className="flex items-center gap-2 rounded bg-black/20 px-2 py-1"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{value}</span>
                    <IconButton label="删除对外地址" danger onClick={() => removeAddress(index)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-qn-muted">尚未添加</div>
            )}
            <div className="flex gap-2">
              <input
                className="qn-input min-w-0 flex-1"
                placeholder="frp.example.com:7001"
                value={addressInput}
                onChange={(event) => {
                  setAddressInput(event.target.value)
                  setFormError(null)
                }}
              />
              <button
                className="qn-button-subtle flex shrink-0 items-center gap-1"
                type="button"
                onClick={addAddress}
              >
                <Plus size={13} /> 添加
              </button>
            </div>
            <p className="text-[11px] leading-5 text-qn-muted">
              frp/端口转发等公网地址，填手机实际访问的地址和端口。
            </p>
          </div>

          <div className="space-y-2 rounded border border-qn-border p-3">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Wifi size={13} /> 局域网地址
              <span className="font-normal text-qn-muted">（自动检测）</span>
            </div>
            {lanOptions.length > 0 ? (
              <ul className="flex flex-wrap gap-1">
                {lanOptions.map((option) => (
                  <li
                    key={option.value}
                    className="rounded border border-qn-border bg-black/20 px-2 py-1 font-mono text-[11px]"
                  >
                    {option.value}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-qn-muted">
                未检测到局域网 IPv4，可改用上面的对外地址。
              </div>
            )}
            <p className="text-[11px] text-qn-muted">按已保存的端口生成，改端口后请保存刷新。</p>
          </div>

          <ErrorNote message={formError} onClose={() => setFormError(null)} />
        </form>

        <div className="space-y-2 rounded border border-qn-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <ShieldCheck size={14} /> 证书指纹（SHA-256）
            </div>
            <button
              className="qn-button-subtle px-2 py-1 text-[11px]"
              type="button"
              disabled={busy !== null || confirmRegen}
              onClick={() => setConfirmRegen(true)}
            >
              重新生成
            </button>
          </div>
          <div className="break-all font-mono text-[11px] leading-5 text-qn-muted">
            {settings?.fingerprint ? groupFingerprint(settings.fingerprint) : '尚未生成'}
          </div>
          {confirmRegen && (
            <div className="space-y-2 rounded border border-qn-danger/50 bg-qn-danger/10 p-2 text-[11px]">
              <p>
                重新生成会更换证书指纹并解除所有已配对设备，已保存的手机连接将失效，须从电脑重新复制连接信息。
              </p>
              <div className="flex gap-2">
                <button
                  className="qn-button px-2 py-1 text-[11px]"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirmRegen(false)
                    void regenerate()
                  }}
                >
                  确认重新生成
                </button>
                <button
                  className="qn-button-subtle px-2 py-1 text-[11px]"
                  type="button"
                  onClick={() => setConfirmRegen(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2 rounded border border-qn-border p-3">
          <div className="text-xs font-medium">复制连接信息</div>
          <div className="flex gap-2">
            <select
              className="qn-input min-w-0 flex-1"
              value={address}
              disabled={options.length === 0}
              onChange={(event) => setSelectedAddress(event.target.value)}
            >
              {options.length === 0 && <option value="">（暂无可用的连接地址）</option>}
              {lanOptions.length > 0 && (
                <optgroup label="局域网地址">
                  {lanOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.value}
                    </option>
                  ))}
                </optgroup>
              )}
              {publicOptions.length > 0 && (
                <optgroup label="对外地址">
                  {publicOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.value}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              className="qn-button flex shrink-0 items-center gap-1"
              type="button"
              disabled={!address || dirty || busy !== null}
              onClick={() => void copyInfo(address)}
            >
              <Copy size={13} /> 复制
            </button>
          </div>
          <p className="text-[11px] leading-5 text-amber-300">含配对密码，请只发给自己。</p>
          {dirty && (
            <p className="text-[11px] text-qn-muted">有未保存的修改，请先保存设置再复制连接信息。</p>
          )}
          {manualCopy && (
            <div className="space-y-1">
              <textarea
                className="qn-input h-28 resize-none font-mono text-[11px]"
                readOnly
                value={manualCopy}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                className="qn-button-subtle px-2 py-1 text-[11px]"
                type="button"
                onClick={clearManualCopy}
              >
                收起
              </button>
            </div>
          )}
        </div>

        <div className="rounded border border-qn-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">已配对设备（{devices.length}）</span>
            <button
              className="qn-button-subtle px-2 py-1 text-[11px]"
              type="button"
              disabled={busy !== null}
              onClick={() => void load()}
            >
              刷新
            </button>
          </div>
          {devices.length === 0 ? (
            <EmptyState>还没有配对设备。复制连接信息并在手机版中添加连接即可配对。</EmptyState>
          ) : (
            <ul className="space-y-1">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center gap-2 rounded border border-qn-border bg-black/20 px-2 py-1.5"
                >
                  <Smartphone size={13} className="shrink-0 text-qn-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{device.name}</div>
                    <div className="truncate text-[11px] text-qn-muted">
                      配对 {formatDeviceTime(device.pairedAt)} · 最近在线{' '}
                      {formatDeviceTime(device.lastSeenAt)} · {device.lastIp || '未知 IP'}
                    </div>
                  </div>
                  <button
                    className="qn-button-subtle shrink-0 px-2 py-1 text-[11px] text-qn-danger"
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
        </div>
      </div>
    </Modal>
  )
}
