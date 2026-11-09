import { useI18n } from '../lib/i18n'
import type { SshConnection } from '../types'

const fieldClass = 'mt-1 min-w-0 w-full rounded border border-dialog-border bg-dialog-input px-2.5 py-1.5 text-ui text-fg outline-none focus:border-accent'
const labelClass = 'block min-w-0 text-ui-sm text-dialog-label'

interface Props {
  candidates: readonly SshConnection[]
  connection: SshConnection
  secret: string
  disabled?: boolean
  onSelect: (id: string) => void
  onSecretChange: (value: string) => void
}

/** 启动、自启与防火墙共用的 SSH 授权字段；凭据只在内存中保留到操作完成。 */
export default function DirectSshAuthFields({ candidates, connection, secret, disabled, onSelect, onSecretChange }: Props) {
  const { t } = useI18n()
  return <>
    <label className={labelClass}>{t('SSH 授权连接')}<select disabled={disabled} value={connection.id} onChange={event => onSelect(event.target.value)} className={fieldClass}>
      {candidates.map(item => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}:{item.port}</option>)}
    </select></label>
    <label className={labelClass}>{t(connection.auth_kind === 'password' ? 'SSH 密码' : 'SSH 私钥口令（可选）')}<input disabled={disabled} type="password" value={secret} onChange={event => onSecretChange(event.target.value)} autoComplete="new-password" placeholder={t('留空使用已保存或当前会话中的 SSH 凭据')} className={fieldClass} /></label>
  </>
}
