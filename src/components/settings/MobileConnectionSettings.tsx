import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, Copy, Eye, EyeOff, LoaderCircle, Smartphone } from 'lucide-react'
import { safeInvoke } from '@/lib/tauri'
import { hasBackend } from '@/lib/runtimeCapabilities'
import { buildPairingLink, formatFingerprint } from '@/lib/mobilePairing'
import { choiceDialog } from '@/store/choiceStore'
import { SettingItem } from '../SettingsLayout'
import Tooltip from '../Tooltip'

interface Device {
  id: string
  name: string
  pairedAt: number
  online: boolean
}

interface Status {
  port: number | null
  savedPort: number
  configured: boolean
  enabled: boolean
  fingerprint: string | null
  devices: Device[]
  addresses: string[]
  computer: string
  error: string | null
}

interface SavedSettings {
  port: number
  configured: boolean
  password: string | null
}

interface QrMatrix {
  size: number
  modules: string
}

const initial: Status = {
  port: null,
  savedPort: 48764,
  configured: false,
  enabled: false,
  fingerprint: null,
  devices: [],
  addresses: [],
  computer: 'Windows',
  error: null,
}
const control = 'setting-control rounded border border-border-strong px-2.5 py-1 text-ui-sm hover:border-accent/60 disabled:opacity-50'
const QUIET_ZONE = 4
const MAX_DEVICES = 8
const PASSWORD = /^[!-~]{6,20}$/

function QrCode({ matrix }: { matrix: QrMatrix }) {
  const path = useMemo(() => {
    const parts: string[] = []
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) {
        if (matrix.modules[y * matrix.size + x] === '1') parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`)
      }
    }
    return parts.join('')
  }, [matrix])
  const extent = matrix.size + QUIET_ZONE * 2
  return (
    <svg viewBox={`0 0 ${extent} ${extent}`} role="img" aria-label="Android 配对二维码"
      className="h-40 w-40 shrink-0 rounded" shapeRendering="crispEdges">
      <rect width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

function pairedDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString()
}

export default function MobileConnectionSettings() {
  const [port, setPort] = useState('48764')
  const [configured, setConfigured] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<Status>(initial)
  const [code, setCode] = useState('')
  const [savedPassword, setSavedPassword] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState<'save' | 'stop' | 'revoke' | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [qr, setQr] = useState<{ link: string; matrix: QrMatrix } | null>(null)
  const enabled = hasBackend()
  const nextPort = Number(port)
  const activePort = status.port
  const host = address && status.addresses.includes(address) ? address : status.addresses[0] ?? null
  const link = activePort !== null && host && status.fingerprint
    ? buildPairingLink({ host, port: activePort, fingerprint: status.fingerprint, name: status.computer })
    : null

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void safeInvoke<SavedSettings>('读取移动连接设置', 'mobile_saved_settings').then(saved => {
      if (cancelled) return
      setPort(String(saved.port))
      setConfigured(saved.configured)
      setCode(saved.password ?? '')
      setSavedPassword(saved.password ?? null)
      setLoaded(true)
    }).catch(error => { if (!cancelled) setFeedback({ text: String(error), error: true }) })
    return () => { cancelled = true }
  }, [enabled])

  useEffect(() => {
    if (!enabled || busy) return
    let cancelled = false
    const refresh = () => {
      void safeInvoke<Status>('查询移动连接', 'mobile_status').then(value => {
        if (!cancelled) setStatus(value)
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [enabled, busy])

  useEffect(() => {
    if (!link || qr?.link === link) return
    let cancelled = false
    void safeInvoke<QrMatrix>('生成配对二维码', 'mobile_pairing_qr', { text: link })
      .then(matrix => { if (!cancelled) setQr({ link, matrix }) })
      .catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [link, qr?.link])

  async function save() {
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      setFeedback({ text: '端口须为 1–65535 之间的整数。', error: true })
      return
    }
    if (activePort === null && (!configured || code) && !PASSWORD.test(code)) {
      setFeedback({ text: '请输入 6–20 位密码，可使用数字、英文字母或符号，无需组合。', error: true })
      return
    }
    if (activePort !== null) {
      const choice = await choiceDialog({
        title: '切换移动连接端口',
        message: `将 TCP ${activePort} 切换到 TCP ${nextPort}？`,
        detail: '新端口就绪后关闭旧端口。已配对的手机和正在运行的手机终端会保留，请在手机的连接详情中把端口改为新端口，或重新扫码。',
        options: [
          { id: 'cancel', label: '取消' },
          { id: 'switch', label: '切换端口', primary: true },
        ],
      })
      if (choice !== 'switch') return
    }
    setBusy('save')
    setFeedback(null)
    try {
      const started = await safeInvoke<Status>('保存移动连接', 'mobile_start', {
        port: nextPort,
        code: activePort === null && code ? code : null,
      })
      setStatus(started)
      setConfigured(true)
      if (activePort === null) {
        if (code) setSavedPassword(code)
        else if (savedPassword) setCode(savedPassword)
      }
      setFeedback({ text: activePort === null
        ? `已保存并启用移动连接，之后启动 QingCode 时会自动启用。`
        : `已切换到 TCP ${nextPort}，旧端口 TCP ${activePort} 已关闭。` })
    } catch (error) {
      setFeedback({ text: activePort === null ? String(error) : `${String(error)} 当前连接仍使用 TCP ${activePort}。`, error: true })
    } finally {
      setBusy(null)
    }
  }

  async function stop() {
    setBusy('stop')
    setFeedback(null)
    try {
      setStatus(await safeInvoke<Status>('停止移动连接', 'mobile_stop', { disable: true }))
      setPort(String(activePort))
      setFeedback({ text: `已停止移动连接，TCP ${activePort} 已关闭，手机终端已结束。已配对的手机会保留，重新启用后可直接连接。` })
    } catch (error) {
      setFeedback({ text: String(error), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function revoke(device: Device) {
    const choice = await choiceDialog({
      title: `移除 ${device.name}？`,
      message: '该手机将无法再连接这台电脑。',
      detail: '它创建的终端会被结束。需要再次使用时，在手机上重新配对。',
      options: [
        { id: 'cancel', label: '取消' },
        { id: 'revoke', label: '移除', danger: true },
      ],
    })
    if (choice !== 'revoke') return
    setBusy('revoke')
    setFeedback(null)
    try {
      setStatus(await safeInvoke<Status>('移除移动设备', 'mobile_revoke_device', { id: device.id }))
      setFeedback({ text: `已移除 ${device.name}。` })
    } catch (error) {
      setFeedback({ text: String(error), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function copyLink() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setFeedback({ text: '已复制配对链接。发到手机后，在 QingCode Android 的「添加连接」中粘贴。' })
    } catch (error) {
      setFeedback({ text: `复制失败：${String(error)}`, error: true })
    }
  }

  const online = status.devices.filter(device => device.online).length
  const busyText = busy === 'save' ? '正在保存并检查端口…' : busy === 'stop' ? '正在关闭监听…' : '正在移除设备…'

  return (
    <div className="mobile-connection-settings">
      <SettingItem
        layout="stacked"
        title="Android 移动连接"
        description="通过局域网或 Tailscale 连接手机。启用后随 QingCode 自动恢复，已配对手机可直接重连。"
      >
        <div className="mobile-connection-body">
          <div className="min-w-0 rounded-lg border border-border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span className="font-medium text-fg">连接设置</span>
              <span className={activePort !== null ? 'text-ok' : 'text-fg-muted'}>
                {activePort !== null
                  ? `已启用 · TCP ${activePort}${online > 0 ? ` · ${online} 台手机在线` : ''}`
                  : '未启用'}
              </span>
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
              <label htmlFor="mobile-connection-port" className="text-ui-sm text-fg">
                端口
              </label>
              <div>
                <input
                  id="mobile-connection-port"
                  type="number"
                  min={1}
                  max={65535}
                  aria-label="移动连接端口"
                  className={control + ' w-32'}
                  value={port}
                  onChange={event => {
                    setPort(event.target.value)
                    setFeedback(null)
                  }}
                  disabled={!loaded || busy !== null}
                />
              </div>
              <label htmlFor="mobile-connection-password" className="text-ui-sm text-fg">
                密码
              </label>
              <div className="relative w-full max-w-80">
                <input
                  id="mobile-connection-password"
                  type={showPassword ? 'text' : 'password'}
                  minLength={6}
                  maxLength={20}
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-label="移动连接密码"
                  placeholder={configured ? '留空沿用已保存密码' : '设置 6–20 位密码'}
                  className="setting-input h-[var(--ui-control-height)] w-full min-w-0 px-2.5 pr-10 text-ui disabled:opacity-50"
                  value={code}
                  onChange={event => {
                    setCode(event.target.value)
                    setFeedback(null)
                  }}
                  disabled={!loaded || busy !== null || activePort !== null}
                />
                <Tooltip
                  label={showPassword ? '隐藏密码' : '显示密码'}
                  wrapperClassName="absolute inset-y-0 right-1 flex items-center"
                >
                  <button
                    type="button"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    aria-pressed={showPassword}
                    disabled={!loaded || busy !== null}
                    onClick={() => setShowPassword(value => !value)}
                    className="inline-flex h-full w-8 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
                  >
                    {showPassword ? (
                      <EyeOff size={16} aria-hidden />
                    ) : (
                      <Eye size={16} aria-hidden />
                    )}
                  </button>
                </Tooltip>
              </div>
              <p className="col-start-2 text-ui-sm leading-relaxed text-fg-muted">
                6–20 位数字、英文字母或符号，无需组合，默认记住。
              </p>
              {configured && (
                <p className="col-start-2 text-ui-sm text-fg-muted">
                  {savedPassword
                    ? '已记住密码，停止连接后可修改。已配对手机不受影响。'
                    : '已保存密码可留空沿用；重新设置后可查看密码。'}
                </p>
              )}
              <div className="col-start-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={control}
                  disabled={!loaded || busy !== null || activePort === nextPort}
                  onClick={() => {
                    void save()
                  }}
                >
                  {busy === 'save' ? '正在保存…' : activePort === null ? '保存并启用' : '切换端口'}
                </button>
                {activePort !== null && (
                  <button
                    type="button"
                    className={control}
                    disabled={busy !== null}
                    onClick={() => {
                      void stop()
                    }}
                  >
                    {busy === 'stop' ? '正在停止…' : '停止连接'}
                  </button>
                )}
              </div>
            </div>
            {status.error && !busy && !feedback && (
              <div
                role="alert"
                className="mt-2 flex items-start gap-2 rounded border border-danger/40 px-3 py-2 text-ui-sm text-danger"
              >
                <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {status.error}
              </div>
            )}
            {(busy || feedback) && (
              <div
                role={feedback?.error && !busy ? 'alert' : 'status'}
                className={`mt-3 flex items-start gap-2 text-ui-sm leading-relaxed ${feedback?.error && !busy ? 'rounded border border-danger/40 px-3 py-2 text-danger' : busy ? 'text-fg' : 'text-ok'}`}
              >
                {busy ? (
                  <LoaderCircle
                    size={16}
                    className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : feedback?.error ? (
                  <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                ) : (
                  <CircleCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                )}
                {busy ? busyText : feedback?.text}
              </div>
            )}
          </div>
          {activePort !== null && status.fingerprint && (
            <div className="mobile-connection-pairing-container">
              <div className="mobile-connection-pairing rounded-lg border border-border p-4">
                <div className="mobile-connection-qr">
                  {qr && qr.link === link ? (
                    <QrCode matrix={qr.matrix} />
                  ) : (
                    <div className="h-40 w-40 rounded border border-border" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0 space-y-3 text-ui-sm leading-relaxed">
                  <div className="font-medium text-fg">配对新手机</div>
                  <ol className="list-decimal space-y-1 pl-5 text-fg-muted">
                    <li>在手机「连接」中点「扫码添加」。</li>
                    <li>扫描二维码，输入上方密码即可配对。</li>
                  </ol>
                  {status.addresses.length > 1 && (
                    <label className="mobile-connection-field">
                      <span className="whitespace-nowrap text-fg-muted">电脑地址</span>
                      <select
                        aria-label="配对使用的电脑地址"
                        className={control + ' min-w-0 w-full'}
                        value={host ?? ''}
                        onChange={event => setAddress(event.target.value)}
                      >
                        {status.addresses.map(item => (
                          <option key={item} value={item}>
                            {item}:{activePort}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {status.addresses.length === 0 && (
                    <div className="text-danger">
                      未找到可用的局域网 IPv4 地址，请检查网络连接。
                    </div>
                  )}
                  {status.addresses.length === 1 && host && (
                    <div className="break-words text-fg-muted">
                      电脑地址{' '}
                      <code>
                        {host}:{activePort}
                      </code>
                    </div>
                  )}
                  <button
                    type="button"
                    className={control + ' inline-flex items-center gap-1.5'}
                    disabled={!link}
                    onClick={() => {
                      void copyLink()
                    }}
                  >
                    <Copy size={14} aria-hidden="true" />
                    复制配对链接
                  </button>
                </div>
                <details className="col-span-full min-w-0 border-t border-border pt-3 text-ui-sm text-fg-muted">
                  <summary className="cursor-pointer hover:text-fg">手动核对证书指纹</summary>
                  <code className="mt-2 block break-all select-text">
                    {formatFingerprint(status.fingerprint)}
                  </code>
                  <p className="mt-1 leading-relaxed">扫码时手机会自动核对证书指纹。</p>
                </details>
              </div>
            </div>
          )}
        </div>
        {status.devices.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-ui-sm font-medium">
              已配对的手机（{status.devices.length}/{MAX_DEVICES}）
            </div>
            <ul
              className="divide-y divide-border rounded border border-border"
              aria-label="已配对的手机"
            >
              {status.devices.map(device => (
                <li key={device.id} className="mobile-connection-device px-3 py-2 text-ui-sm">
                  <Smartphone size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
                  <Tooltip label={device.name} onlyWhenOverflow wrapperClassName="min-w-0">
                    <span className="block truncate">{device.name}</span>
                  </Tooltip>
                  <span
                    className={`mobile-connection-device-status ${device.online ? 'text-ok' : 'text-fg-muted'}`}
                  >
                    {device.online ? '在线' : `配对于 ${pairedDate(device.pairedAt)}`}
                  </span>
                  <button
                    type="button"
                    className={control + ' mobile-connection-device-remove'}
                    disabled={busy !== null}
                    aria-label={`移除 ${device.name}`}
                    onClick={() => {
                      void revoke(device)
                    }}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingItem>
    </div>
  )
}
