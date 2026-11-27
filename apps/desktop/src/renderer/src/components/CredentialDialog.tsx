import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
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
      setError('请输入密码')
      return
    }
    onSubmit({
      remember,
      ...(isKey ? { passphrase: secret } : { password: secret }),
    })
  }

  return (
    <Modal
      title={`连接到 ${target.name}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button className="qn-button-subtle" type="button" onClick={onClose}>
            取消
          </button>
          <button className="qn-button" type="submit" form="credential-form">
            连接
          </button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-qn-border bg-qn-inset px-3 py-2 text-ui-sm text-qn-muted">
        <KeyRound size={14} />
        <span className="truncate">{target.username}@{target.host}:{target.port}</span>
      </div>
      <form id="credential-form" className="space-y-3" onSubmit={submit}>
        <FormField label={isKey ? '私钥口令（没有口令可留空）' : '密码'}>
          {(control) => (
            <PasswordInput
              {...control}
              autoFocus
              value={secret}
              placeholder={isKey ? '私钥口令' : 'SSH 密码'}
              onChange={(event) => {
                setSecret(event.target.value)
                setError(null)
              }}
            />
          )}
        </FormField>
        <Checkbox checked={remember} onChange={setRemember}>
          记住密码 / 口令（用本机系统加密保存）
        </Checkbox>
        <ErrorNote message={error} onClose={() => setError(null)} />
      </form>
    </Modal>
  )
}
