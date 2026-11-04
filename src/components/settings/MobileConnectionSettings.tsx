import { useEffect, useState } from 'react'
import { isTauri, safeInvoke } from '@/lib/tauri'

interface Status {
  address: string | null
  paired: boolean
  fingerprint: string | null
}

interface SavedSettings {
  address: string | null
  port: number
  configured: boolean
}

const stopped: Status = { address: null, paired: false, fingerprint: null }
const control = 'setting-control rounded border border-border-strong px-2.5 py-1 text-ui-sm hover:border-accent/60 disabled:opacity-50'

export default function MobileConnectionSettings() {
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('48764')
  const [configured, setConfigured] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<Status>(stopped)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const enabled = isTauri()

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void safeInvoke<SavedSettings>('读取移动连接设置', 'mobile_saved_settings').then(async saved => {
      const ip = saved.address ?? await safeInvoke<string | null>('识别局域网地址', 'mobile_suggest_address')
      if (cancelled) return
      setAddress(ip ?? '')
      setPort(String(saved.port))
      setConfigured(saved.configured)
      setLoaded(true)
    }).catch(error => { if (!cancelled) setMessage(String(error)) })
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

  async function change(start: boolean) {
    setBusy(true)
    setMessage('')
    try {
      if (start) {
        const started = await safeInvoke<Status>('启用移动连接', 'mobile_start', {
          address: address.trim(),
          port: Number(port),
          code: code || null,
        })
        setStatus(started)
        setConfigured(true)
      } else {
        await safeInvoke('停止移动连接', 'mobile_stop')
        setStatus(stopped)
      }
      setCode('')
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border-b border-border px-1 py-3">
      <div className="font-medium">Android 移动连接</div>
      <p className="text-ui-sm text-text-muted">
        手机与电脑连接同一局域网。设置 6 位验证码，包含英文字母和数字，也可使用符号。验证码会保留到手动更换。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={control}
          aria-label="Windows 局域网 IPv4 地址"
          placeholder="Windows 局域网 IPv4"
          value={status.address?.split(':')[0] ?? address}
          onChange={event => setAddress(event.target.value)}
          disabled={!loaded || busy || !!status.address}
        />
        <input type="number" min={1} max={65535} aria-label="移动连接端口" className={control + ' w-24'}
          value={status.address?.split(':')[1] ?? port} onChange={event => setPort(event.target.value)}
          disabled={!loaded || busy || !!status.address} />
        {!status.address && (
          <>
          <input type="password" maxLength={6} autoComplete="new-password" spellCheck={false}
            aria-label="移动连接验证码" placeholder={configured ? '留空沿用已保存验证码' : '设置 6 位验证码'}
            className={control} value={code} onChange={event => setCode(event.target.value)} disabled={!loaded || busy} />
          <button type="button" className={control}
            disabled={!loaded || busy || !address.trim() || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 || (code ? code.length !== 6 : !configured)}
            onClick={() => { void change(true) }}>
            保存并启用
          </button>
          </>
        )}
        {status.address && (
          <button type="button" className={control} disabled={busy} onClick={() => { void change(false) }}>停止连接</button>
        )}
        {status.paired && <span role="status" className="text-ui-sm">Android 已配对</span>}
      </div>
      {status.fingerprint && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-sm">首次连接核对 SHA-256 指纹</span>
          <code className="break-all text-ui-sm">{status.fingerprint}</code>
        </div>
      )}
      {message && <p role="status" className="text-ui-sm">{message}</p>}
    </div>
  )
}
