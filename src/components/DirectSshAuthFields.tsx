import { useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { hasSshSessionSecrets, hydrateSshSecrets } from '../lib/sshWorkspace'
import type { SshConnection } from '../types'

// 控件高度显式固定（行高 + 上下内边距 + 边框）：原生 select 不遵循 line-height，会比右侧提示文字更高导致错位。
const controlHeight = 'h-[calc(var(--ui-line-height)+14px)]'
const fieldClass = `mt-1 ${controlHeight} min-w-0 w-full rounded-md border border-dialog-border bg-dialog-input px-2.5 py-1.5 text-ui text-fg outline-none focus:border-accent`
const labelClass = 'block min-w-0 text-ui-sm text-dialog-label'

interface Props {
  candidates: readonly SshConnection[]
  connection: SshConnection
  secret: string
  disabled?: boolean
  onSelect: (id: string) => void
  onSecretChange: (value: string) => void
}

/**
 * 启动、自启与防火墙共用的 SSH 授权字段；凭据只在内存中保留到操作完成。
 * 本机已保存或本次会话已有凭据时不再要求重复填写，只留「改用其他凭据」入口；
 * 私钥登录的口令是可选项，同样默认收起。
 */
export default function DirectSshAuthFields({ candidates, connection, secret, disabled, onSelect, onSecretChange }: Props) {
  const { t } = useI18n()
  const [saved, setSaved] = useState(() => hasSshSessionSecrets(connection.id))
  const [editing, setEditing] = useState(false)
  const password = connection.auth_kind === 'password'

  useEffect(() => {
    let stale = false
    setEditing(false)
    setSaved(hasSshSessionSecrets(connection.id))
    void hydrateSshSecrets(connection.id).then(() => {
      if (!stale) setSaved(hasSshSessionSecrets(connection.id))
    }).catch(() => {})
    return () => { stale = true }
  }, [connection.id])

  const showField = editing || Boolean(secret) || (password && !saved)
  return <>
    <label className={labelClass}>{t('SSH 授权连接')}<select disabled={disabled} value={connection.id} onChange={event => onSelect(event.target.value)} className={fieldClass}>
      {candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}:{item.port}</option>)}
    </select></label>
    {showField
      ? <label className={labelClass}>{t(password ? 'SSH 密码' : 'SSH 私钥口令（可选）')}<input disabled={disabled} type="password" value={secret} onChange={event => onSecretChange(event.target.value)} autoComplete="new-password" placeholder={t(saved ? '留空使用已保存或当前会话中的 SSH 凭据' : password ? '填写此 SSH 账户的密码' : '私钥未设口令时留空')} className={fieldClass} /></label>
      // 与左侧下拉框同高并贴底，flex 居中，双列时文字与下拉框垂直居中对齐。
      : <p className={`flex min-w-0 flex-wrap items-center self-end min-h-[calc(var(--ui-line-height)+14px)] text-ui text-fg-muted`}>
        <span className="mr-2 text-ui-sm">{t(saved ? '将使用已保存的 SSH 凭据。' : '将使用私钥登录。')}</span>
        <button type="button" disabled={disabled} onClick={() => setEditing(true)} className="text-ui-sm text-accent hover:underline disabled:opacity-40">{t(saved ? '改用其他凭据' : '填写私钥口令')}</button>
      </p>}
  </>
}
