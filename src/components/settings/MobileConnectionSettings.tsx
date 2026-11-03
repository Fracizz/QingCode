import { useEffect, useState } from 'react'
import { isTauri, safeInvoke } from '@/lib/tauri'

interface Status {
  address: string | null
  paired: boolean
}

interface Pairing {
  address: string
  code: string
}

const control = 'setting-control rounded border border-border-strong px-2.5 py-1 text-ui-sm hover:border-accent/60 disabled:opacity-50'

export default function MobileConnectionSettings() {
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState<Status>({ address: null, paired: false })
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const enabled = isTauri()

  useEffect(() => {
    if (!enabled || busy) return
    let cancelled = false
    void safeInvoke<string | null>('识别局域网地址', 'mobile_suggest_address').then(value => {
      if (!cancelled && value) setAddress(current => current || value)
    }).catch(() => {})
    const refresh = () => {
      void safeInvoke<Status>('查询移动连接', 'mobile_status').then(value => {
        if (cancelled) return
        setStatus(value)
        if (value.paired || !value.address) setCode('')
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
        const pairing = await safeInvoke<Pairing>('生成移动连接验证码', 'mobile_start', {
          address: status.address?.split(':')[0] ?? address.trim(),
        })
        setStatus({ address: pairing.address, paired: false })
        setCode(pairing.code)
      } else {
        await safeInvoke('停止移动连接', 'mobile_stop')
        setStatus({ address: null, paired: false })
        setCode('')
      }
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
        手机与电脑连接同一局域网。配对后可打开已信任项目的终端，停止连接会撤销配对并结束手机创建的终端。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={control}
          aria-label="Windows 局域网 IPv4 地址"
          placeholder="Windows 局域网 IPv4"
          value={status.address ?? address}
          onChange={event => setAddress(event.target.value)}
          disabled={busy || !!status.address}
        />
        {!status.paired && (
          <button type="button" className={control} disabled={busy || !enabled || (!status.address && !address.trim())}
            onClick={() => { void change(true) }}>
            {status.address ? '刷新验证码' : '启用并生成验证码'}
          </button>
        )}
        {status.address && (
          <button type="button" className={control} disabled={busy} onClick={() => { void change(false) }}>停止连接</button>
        )}
        {status.paired && <span role="status" className="text-ui-sm">Android 已配对</span>}
      </div>
      {code && (
        <div className="flex flex-wrap items-center gap-2">
          <input className={control + ' min-w-60 flex-1 font-mono'} aria-label="移动连接验证码" readOnly value={code} />
          <button type="button" className={control} onClick={() => {
            void navigator.clipboard.writeText(code).then(
              () => setMessage('已复制验证码，有效期 5 分钟。'),
              () => setMessage('请选中并复制验证码。'),
            )
          }}>复制验证码</button>
        </div>
      )}
      {message && <p role="status" className="text-ui-sm">{message}</p>}
    </div>
  )
}
