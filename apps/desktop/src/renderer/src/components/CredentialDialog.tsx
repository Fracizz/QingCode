import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { t } from '@qn/codex-client'
import type { SshTarget } from '../../../shared/backendApi'
import { FormField } from './FormField'
import { PasswordInput } from './PasswordInput'
import type { ConnectCredentials } from '../store/targets'
import { Checkbox, ErrorNote, Modal } from './ui'

export function CredentialDialog({
  target,
  initialRemember = true,
  onClose,
  onSubmit,
}: {
  target: SshTarget
  initialRemember?: boolean
  onClose: () => void
  onSubmit: (credentials: ConnectCredentials) => void
}) {
  const isKey = target.auth.kind === 'key'
  const [secret, setSecret] = useState('')
  const [remember, setRemember] = useState(initialRemember)
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!isKey && !secret) {
      setError(t('请输入密码'))
      return
    }
    onSubmit({
      remember,
      ...(isKey ? { passphrase: secret } : { password: secret }),
    })
  }

  return (
    <Modal
      title={t('连接到 {name}', { name: target.name })}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button className="qn-button-subtle" type="button" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="qn-button" type="submit" form="credential-form">
            {t('连接')}
          </button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-qn-border bg-qn-inset px-3 py-2 text-ui-sm text-qn-muted">
        <KeyRound size={14} />
        <span className="truncate">{target.username}@{target.host}:{target.port}</span>
      </div>
      <form id="credential-form" className="space-y-3" onSubmit={submit}>
        <FormField label={isKey ? t('私钥口令（没有口令可留空）') : t('密码')}>
          {(control) => (
            <PasswordInput
              {...control}
              autoFocus
              value={secret}
              placeholder={isKey ? t('私钥口令') : t('SSH 密码')}
              onChange={(event) => {
                setSecret(event.target.value)
                setError(null)
              }}
            />
          )}
        </FormField>
        <Checkbox checked={remember} onChange={setRemember}>
          {t('记住密码 / 口令（用本机系统加密保存）')}
        </Checkbox>
        <ErrorNote message={error} onClose={() => setError(null)} />
      </form>
    </Modal>
  )
}
