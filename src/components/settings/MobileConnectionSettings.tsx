import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import { isTauri, safeInvoke } from '@/lib/tauri'
import { choiceDialog } from '@/store/choiceStore'

interface Status {
  port: number | null
  paired: boolean
  fingerprint: string | null
}

interface SavedSettings {
  port: number
  configured: boolean
}

const stopped: Status = { port: null, paired: false, fingerprint: null }
const control = 'setting-control rounded border border-border-strong px-2.5 py-1 text-ui-sm hover:border-accent/60 disabled:opacity-50'

export default function MobileConnectionSettings() {
  const [port, setPort] = useState('48764')
  const [configured, setConfigured] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<Status>(stopped)
  const [code, setCode] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState<'save' | 'stop' | null>(null)
  const enabled = isTauri()
  const nextPort = Number(port)
  const activePort = status.port

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void safeInvoke<SavedSettings>('读取移动连接设置', 'mobile_saved_settings').then(saved => {
      if (cancelled) return
      setPort(String(saved.port))
      setConfigured(saved.configured)
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

  async function save() {
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      setFeedback({ text: '端口须为 1–65535 之间的整数。', error: true })
      return
    }
    if (activePort === null && (!configured || code) && !/^(?=.*[A-Za-z])(?=.*[0-9])[!-~]{6}$/.test(code)) {
      setFeedback({ text: '请输入 6 位验证码，须包含英文字母和数字，可加入符号。', error: true })
      return
    }
    if (activePort !== null) {
      const choice = await choiceDialog({
        title: '切换移动连接端口',
        message: `将 TCP ${activePort} 切换到 TCP ${nextPort}？`,
        detail: '新端口就绪后会关闭旧端口、撤销手机配对，并尝试结束手机创建的终端。请在手机上使用新端口重新配对。',
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
      setCode('')
      setFeedback({ text: activePort === null
        ? `已保存并启用移动连接，TCP ${nextPort} 正在监听。`
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
      await safeInvoke('停止移动连接', 'mobile_stop')
      setStatus(stopped)
      setPort(String(activePort))
      setFeedback({ text: `已停止移动连接，TCP ${activePort} 已关闭。` })
    } catch (error) {
      setFeedback({ text: String(error), error: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-2 border-b border-border px-1 py-3">
      <div className="font-medium">Android 移动连接</div>
      <p className="text-ui-sm text-text-muted">
        手机与电脑连接同一局域网。手机填写电脑的局域网 IPv4、下方端口和 6 位验证码。验证码会保留到手动更换。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-ui-sm">
          端口
          <input type="number" min={1} max={65535} aria-label="移动连接端口" className={control + ' w-24'}
            value={port} onChange={event => { setPort(event.target.value); setFeedback(null) }}
            disabled={!loaded || busy !== null} />
        </label>
        {activePort === null && (
          <input type="password" maxLength={6} autoComplete="new-password" spellCheck={false}
            aria-label="移动连接验证码" placeholder={configured ? '留空沿用已保存验证码' : '设置 6 位验证码'}
            className={control} value={code} onChange={event => { setCode(event.target.value); setFeedback(null) }} disabled={!loaded || busy !== null} />
        )}
        <button type="button" className={control} disabled={!loaded || busy !== null || activePort === nextPort}
          onClick={() => { void save() }}>
          {busy === 'save' ? '正在保存…' : activePort === null ? '保存并启用' : '切换端口'}
        </button>
        {activePort !== null && (
          <>
            <button type="button" className={control} disabled={busy !== null} onClick={() => { void stop() }}>
              {busy === 'stop' ? '正在停止…' : '停止连接'}
            </button>
            <span className="text-ui-sm text-ok">已启用 · TCP {activePort}{status.paired ? ' · Android 已配对' : ''}</span>
          </>
        )}
      </div>
      {(busy || feedback) && (
        <div role={feedback?.error ? 'alert' : 'status'} className={`flex items-start gap-2 rounded border px-3 py-2 text-ui-sm ${busy ? 'border-accent/40 text-fg' : feedback?.error ? 'border-danger/40 text-danger' : 'border-ok/40 text-ok'}`}>
          {busy
            ? <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : feedback?.error
              ? <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              : <CircleCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
          {busy === 'save' ? '正在保存并检查端口…' : busy === 'stop' ? '正在关闭监听…' : feedback?.text}
        </div>
      )}
      {status.fingerprint && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-sm">首次连接核对 SHA-256 指纹</span>
          <code className="break-all text-ui-sm">{status.fingerprint}</code>
        </div>
      )}
    </div>
  )
}
