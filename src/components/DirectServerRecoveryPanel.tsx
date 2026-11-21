import { useState } from 'react'
import { LoaderCircle, Play } from 'lucide-react'
import { directAgentApi, directAgentSshCandidates, type DirectAgentApi, type DirectAgentInfo } from '../lib/directAgent'
import { useDirectServerManage } from '../hooks/useDirectServerManage'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import type { SshConnection } from '../types'
import DirectSshAuthFields from './DirectSshAuthFields'

interface Props {
  connectionId: string
  info: DirectAgentInfo
  fallbackConnection?: SshConnection
  connections?: readonly SshConnection[]
  api?: DirectAgentApi
  onStarted?: () => void | Promise<void>
  onUpdated?: (info: DirectAgentInfo) => void | Promise<void>
  onBusyChange?: (busy: boolean) => void
  onConfigure?: () => void
}

export default function DirectServerRecoveryPanel({ connectionId, info, fallbackConnection, connections, api = directAgentApi, onStarted, onUpdated, onBusyChange, onConfigure }: Props) {
  const { t } = useI18n()
  const stored = useProjectStore(state => state.sshConnections)
  const candidates = directAgentSshCandidates([...(connections ?? stored), ...(fallbackConnection && !(connections ?? stored).some(c => c.id === fallbackConnection.id) ? [fallbackConnection] : [])], info.host)
  const [sshId, setSshId] = useState('')
  const ssh = candidates.find(c => c.id === sshId) ?? candidates.find(c => c.id === connectionId) ?? candidates[0]
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [warning, setWarning] = useState('')
  const { busy, manage } = useDirectServerManage({
    connectionId, info, ssh, password, passphrase, api, onStarted, onBusyChange,
    onManaged: async result => {
      setPassword('')
      setPassphrase('')
      await onUpdated?.(result)
    },
  })

  const run = async () => {
    setError('')
    setNotice('')
    setWarning('')
    const outcome = await manage()
    if (!outcome) return
    if (outcome.warning) setWarning(outcome.warning)
    setError(outcome.error ?? '')
    setNotice(outcome.notice ?? '')
  }
  const configure = () => { onConfigure?.(); useUIStore.getState().openRemoteConnections() }
  const button = 'btn btn-secondary border-dialog-border'

  return <section aria-label={t('启动与开机自启')} className="@container/recovery min-w-0 space-y-2.5 rounded border border-dialog-border bg-dialog-sidebar p-3">
    <p className="text-ui-sm text-fg-muted">{t('Server 默认开机自启。可通过 SSH 启动已配对的 Server，随后使用原配对凭据直连。')}</p>
    {ssh ? <>
      <div className="grid min-w-0 grid-cols-1 gap-2.5 @min-[32rem]/recovery:grid-cols-2">
        <DirectSshAuthFields
          candidates={candidates}
          connection={ssh}
          secret={ssh.auth_kind === 'password' ? password : passphrase}
          disabled={busy}
          onSelect={id => { setSshId(id); setPassword(''); setPassphrase(''); setError('') }}
          onSecretChange={value => { if (ssh.auth_kind === 'password') setPassword(value); else setPassphrase(value) }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void run()} className={button}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}{t(busy ? '正在通过 SSH 管理 Server…' : '通过 SSH 启动 Server')}</button>
      </div>
    </> : <>
      <p className="text-ui-sm text-fg-muted">{t('未找到此主机的 SSH 连接。可配置 SSH 后启动，或在远端手动运行以下命令。')}</p>
      <button type="button" onClick={configure} className={button}>{t('配置 SSH 连接')}</button>
    </>}
    <details className="text-ui-sm text-fg-muted"><summary className="cursor-pointer">{t('远端手动启动命令')}</summary>
      <p className="my-2">{t('使用原安装账户和原 Server 程序运行，保留配对信息。Windows 自启需管理员权限，Linux 需 systemd。')}</p>
      <code className="block whitespace-pre-wrap break-all rounded bg-dialog-input p-2 font-mono">{`qingcode-server direct --port ${info.port} --detach\nqingcode-server startup enable`}</code>
    </details>
    {error && <p role="alert" className="text-ui-sm text-danger">{t(error)}</p>}
    {warning && !busy && <p role="status" className="break-words text-ui-sm text-warn">{t('未能配置开机自启，远端重启后需手动启动。原因：{reason}', { reason: warning })}</p>}
    {(busy || notice) && <p role="status" className="text-ui-sm text-fg-muted">{busy ? t('正在通过 SSH 管理 Server…') : t(notice)}</p>}
  </section>
}
