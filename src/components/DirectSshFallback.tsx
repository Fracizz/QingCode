import { useState } from 'react'
import { ArrowLeftRight, LoaderCircle } from 'lucide-react'
import type { SshConnection, SshConnectionMode } from '../types'
import type { DirectAgentInfo } from '../lib/directAgent'
import { restoreSshTransport } from '../lib/sshWorkspace'
import { useI18n } from '../lib/i18n'
import { useUIStore } from '../store/uiStore'
import { confirmDialog } from '../store/confirmStore'

interface Props {
  connection: SshConnection
  info: DirectAgentInfo
  disabled?: boolean
  onSwitched: (info: DirectAgentInfo) => void | Promise<void>
  onConfigure?: () => void
  onBusyChange?: (busy: boolean) => void
}

export default function DirectSshFallback({ connection, info, disabled, onSwitched, onConfigure, onBusyChange }: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<SshConnectionMode>('server')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const standalone = connection.username === 'Agent' && connection.auth_kind === 'password' && connection.host_key_fingerprint === info.certificateFingerprint
  const button = 'inline-flex items-center gap-1.5 rounded border border-dialog-border px-3 py-1.5 text-ui text-fg hover:bg-bg-hover disabled:opacity-40'
  const switchTransport = async () => {
    if (busy || disabled) return
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    try {
      if (!await confirmDialog({
        title: t('切换到 SSH'),
        message: t('将断开当前 Server 数据连接，并使用已保存的 SSH 地址与身份。终端连接会中断；Server 配对信息保留，可稍后重新启用。'),
        detail: `${connection.username}@${connection.host}:${connection.port}\n${t(mode === 'server' ? 'SSH + 远端服务' : 'SSH 直连（兼容模式）')}`,
        kind: 'warning', confirmLabel: t('切换到 SSH'), cancelLabel: t('取消'),
      })) return
      const next = await restoreSshTransport(connection, info, mode)
      await onSwitched(next)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }
  return <section aria-label={t('切换连接方式')} className="space-y-2 rounded border border-dialog-border bg-dialog-sidebar p-3">
    <p className="text-ui font-medium text-fg">{t('端口不可用？改用 SSH')}</p>
    {standalone ? <>
      <p className="text-ui-sm text-fg-muted">{t('此连接仅保存 Server 配对信息。请先配置 SSH 地址与身份，再通过 SSH 打开项目。')}</p>
      <button type="button" disabled={disabled || busy} className={button} onClick={() => { onConfigure?.(); useUIStore.setState({ remoteConnectionsOpen: true, remoteConnectionsCreating: true }) }}>{t('新建 SSH 连接')}</button>
    </> : <>
      <p className="break-all text-ui-sm text-fg-muted">{connection.username}@{connection.host}:{connection.port}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 text-ui-sm text-dialog-label">{t('SSH 连接方式')}
          <select value={mode} disabled={disabled || busy} onChange={event => setMode(event.target.value as SshConnectionMode)} className="mt-1 block max-w-full rounded border border-dialog-border bg-dialog-input px-2 py-1.5 text-ui text-fg">
            <option value="server">{t('SSH + 远端服务')}</option>
            <option value="ssh">{t('SSH 直连（兼容模式）')}</option>
          </select>
        </label>
        <button type="button" disabled={disabled || busy} onClick={() => void switchTransport()} className={button}>
          {busy ? <LoaderCircle size={13} className="animate-spin" /> : <ArrowLeftRight size={13} />}{t(busy ? '正在切换…' : '切换到 SSH')}
        </button>
      </div>
      <p className="text-ui-sm text-fg-muted">{t('切换后通过 SSH 连接；需要认证时会提示输入凭据。')}</p>
    </>}
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-ui-sm text-danger">{error}</p>}
  </section>
}
