import { useState, type FormEvent } from 'react'
import type { SshAuth, SshTarget, SshTargetInput } from '../../../shared/backendApi'
import type { ConnectCredentials } from '../store/targets'
import { useTargets } from '../store/targets'
import { friendlyError } from '../lib/errors'
import { Checkbox, ErrorNote, IconButton, Modal } from './ui'
import { Folder } from 'lucide-react'

type Draft = {
  name: string
  host: string
  port: string
  username: string
  authKind: 'password' | 'key' | 'agent'
  keyPath: string
  password: string
  passphrase: string
  remember: boolean
}

const emptyDraft: Draft = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  authKind: 'password',
  keyPath: '',
  password: '',
  passphrase: '',
  remember: false,
}

function draftFrom(target: SshTarget): Draft {
  return {
    ...emptyDraft,
    name: target.name,
    host: target.host,
    port: String(target.port),
    username: target.username,
    authKind: target.auth.kind,
    keyPath: target.auth.kind === 'key' ? target.auth.keyPath : '',
  }
}

export function TargetForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: SshTarget
  onClose: () => void
  onSaved: (target: SshTarget, credentials: ConnectCredentials) => void
}) {
  const save = useTargets((s) => s.save)
  const [draft, setDraft] = useState<Draft>(() => (initial ? draftFrom(initial) : emptyDraft))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const patch = (part: Partial<Draft>) => setDraft((value) => ({ ...value, ...part }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('端口需为 1–65535 的整数')
      return
    }
    const host = draft.host.trim()
    if (!host) {
      setError('主机不能为空')
      return
    }
    let auth: SshAuth
    if (draft.authKind === 'key') {
      if (!draft.keyPath.trim()) {
        setError('请选择私钥文件')
        return
      }
      auth = { kind: 'key', keyPath: draft.keyPath.trim() }
    } else if (draft.authKind === 'password') {
      auth = { kind: 'password' }
    } else {
      auth = { kind: 'agent' }
    }
    const input: SshTargetInput = {
      ...(initial ? { id: initial.id } : {}),
      name: draft.name.trim() || `${draft.username.trim() || 'root'}@${host}`,
      host,
      port,
      username: draft.username.trim() || 'root',
      auth,
    }
    try {
      setBusy(true)
      const target = await save(input)
      const credentials: ConnectCredentials = { remember: draft.remember }
      if (draft.authKind === 'password' && draft.password) credentials.password = draft.password
      if (draft.authKind === 'key' && draft.passphrase) credentials.passphrase = draft.passphrase
      onSaved(target, credentials)
      onClose()
    } catch (err) {
      setError(friendlyError(err, '保存连接失败'))
    } finally {
      setBusy(false)
    }
  }

  const pickKey = async () => {
    if (typeof window === 'undefined') return
    try {
      const path = await window.qn.openFile()
      if (path) patch({ keyPath: path })
    } catch (err) {
      setError(friendlyError(err, '选择私钥文件失败'))
    }
  }

  const secretLabel = draft.authKind === 'key' ? '私钥口令（可选）' : '密码（连接时使用）'

  return (
    <Modal
      title={initial ? '编辑 SSH 连接' : '添加 SSH 连接'}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button className="qn-button-subtle" type="button" onClick={onClose}>
            取消
          </button>
          <button className="qn-button" type="submit" form="target-form" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <form id="target-form" className="space-y-2" onSubmit={(e) => void submit(e)}>
        <input className="qn-input" placeholder="名称" value={draft.name}
          onChange={(e) => patch({ name: e.target.value })} />
        <div className="flex gap-2">
          <input className="qn-input min-w-0 flex-1" placeholder="主机" value={draft.host}
            onChange={(e) => patch({ host: e.target.value })} />
          <input className="qn-input w-20" placeholder="端口" inputMode="numeric" value={draft.port}
            onChange={(e) => patch({ port: e.target.value })} />
        </div>
        <input className="qn-input" placeholder="用户名" value={draft.username}
          onChange={(e) => patch({ username: e.target.value })} />
        <select className="qn-input" value={draft.authKind}
          onChange={(e) => patch({ authKind: e.target.value as Draft['authKind'] })}>
          <option value="password">密码</option>
          <option value="key">私钥文件</option>
          <option value="agent">ssh-agent</option>
        </select>
        {draft.authKind === 'key' && (
          <div className="flex gap-2">
            <input className="qn-input min-w-0 flex-1" placeholder="私钥路径" value={draft.keyPath}
              onChange={(e) => patch({ keyPath: e.target.value })} />
            <IconButton label="选择私钥文件" onClick={() => void pickKey()}>
              <Folder size={14} />
            </IconButton>
          </div>
        )}
        {(draft.authKind === 'password' || draft.authKind === 'key') && (
          <>
            <input className="qn-input" type="password" placeholder={secretLabel}
              value={draft.authKind === 'key' ? draft.passphrase : draft.password}
              onChange={(e) => patch(draft.authKind === 'key' ? { passphrase: e.target.value } : { password: e.target.value })} />
            <Checkbox checked={draft.remember} onChange={(value) => patch({ remember: value })}>
              记住密码 / 口令（用本机系统加密保存）
            </Checkbox>
            <p className="text-[12px] leading-5 text-qn-muted">
              凭据只在连接时传给 backend，不写入连接配置。
            </p>
          </>
        )}
        <ErrorNote message={error} onClose={() => setError(null)} />
      </form>
    </Modal>
  )
}
