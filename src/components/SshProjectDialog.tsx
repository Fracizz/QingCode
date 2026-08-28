import { useEffect, useRef, useState } from 'react'
import { KeyRound, Server, X } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import { probeSshHost, type SshRuntimeConfig } from '../lib/sshWorkspace'
import type { SshConnection } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  onAdded: () => void
}

type AuthKind = SshConnection['auth_kind']

export default function SshProjectDialog({ open: visible, onClose, onAdded }: Props) {
  const addSshProject = useProjectStore(state => state.addSshProject)
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [authKind, setAuthKind] = useState<AuthKind>('privateKey')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const closedRef = useRef(false)

  useEffect(() => {
    if (visible) closedRef.current = false
  }, [visible])

  const handleClose = () => {
    closedRef.current = true
    onClose()
  }

  if (!visible) return null

  const choosePrivateKey = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: '选择 SSH 私钥',
    })
    if (typeof selected === 'string') setPrivateKeyPath(selected)
  }

  const submit = async () => {
    if (submitting) return
    const normalizedHost = host.trim()
    const normalizedUser = username.trim()
    const normalizedRoot = rootPath.trim()
    const normalizedPort = Number.parseInt(port, 10)
    if (!normalizedHost || !normalizedUser || !normalizedRoot.startsWith('/')) {
      setError('请填写主机、用户名和以 / 开头的远程项目路径。')
      return
    }
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setError('SSH 端口必须在 1–65535 之间。')
      return
    }
    if (authKind === 'privateKey' && !privateKeyPath.trim()) {
      setError('请选择 SSH 私钥文件。')
      return
    }
    if (authKind === 'password' && !password) {
      setError('请输入 SSH 密码。')
      return
    }

    setSubmitting(true)
    setError('')
    const id = crypto.randomUUID()
    const runtimeConfig: Omit<SshRuntimeConfig, 'hostKeyFingerprint'> = {
      id,
      host: normalizedHost,
      port: normalizedPort,
      username: normalizedUser,
      authKind,
      privateKeyPath: privateKeyPath.trim() || undefined,
      password: password || undefined,
      passphrase: passphrase || undefined,
    }
    try {
      const fingerprint = await probeSshHost(runtimeConfig)
      if (closedRef.current) return
      const accepted = await confirmDialog({
        title: '确认 SSH 主机指纹',
        message: `首次连接 ${normalizedUser}@${normalizedHost}，请确认主机指纹。`,
        detail: fingerprint,
        kind: 'warning',
        confirmLabel: '信任此主机',
        cancelLabel: '取消',
      })
      if (closedRef.current || !accepted) return

      const now = Date.now()
      const connection: SshConnection = {
        id,
        name: name.trim() || normalizedHost,
        host: normalizedHost,
        port: normalizedPort,
        username: normalizedUser,
        auth_kind: authKind,
        private_key_path: privateKeyPath.trim() || undefined,
        host_key_fingerprint: fingerprint,
        created_at: now,
        updated_at: now,
      }
      const added = await addSshProject(connection, normalizedRoot, name.trim(), {
        password: password || undefined,
        passphrase: passphrase || undefined,
      })
      if (closedRef.current) return
      if (added) onAdded()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSubmitting(false)
    }
  }

  const fieldClass =
    'w-full rounded border border-border-strong bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent'

  return (
    <ModalOverlay onDismiss={handleClose} zIndex="z-[120]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-project-title"
        className="ui-font-scaled modal-content-enter flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Server size={17} className="text-accent" />
          <h2 id="ssh-project-title" className="flex-1 text-[14px] font-semibold text-fg">
            打开 SSH 项目
          </h2>
          <Tooltip label="关闭" side="left">
            <button
              type="button"
              onClick={handleClose}
              className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-x-3 gap-y-3 overflow-y-auto px-4 py-4">
          <label className="col-span-2 text-[12px] text-fg-muted">
            连接/项目名称
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="默认使用主机名或目录名"
              className={`${fieldClass} mt-1`}
            />
          </label>
          <label className="text-[12px] text-fg-muted">
            主机
            <input
              value={host}
              onChange={event => setHost(event.target.value)}
              placeholder="192.168.1.10"
              className={`${fieldClass} mt-1`}
            />
          </label>
          <label className="text-[12px] text-fg-muted">
            端口
            <input
              value={port}
              onChange={event => setPort(event.target.value)}
              inputMode="numeric"
              className={`${fieldClass} mt-1`}
            />
          </label>
          <label className="text-[12px] text-fg-muted">
            用户名
            <input
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="root"
              className={`${fieldClass} mt-1`}
            />
          </label>
          <label className="text-[12px] text-fg-muted">
            认证方式
            <select
              value={authKind}
              onChange={event => setAuthKind(event.target.value as AuthKind)}
              className={`${fieldClass} mt-1`}
            >
              <option value="privateKey">私钥</option>
              <option value="password">密码（仅本次会话）</option>
            </select>
          </label>

          {authKind === 'privateKey' ? (
            <>
              <label className="col-span-2 text-[12px] text-fg-muted">
                私钥文件
                <div className="mt-1 flex gap-2">
                  <input
                    value={privateKeyPath}
                    onChange={event => setPrivateKeyPath(event.target.value)}
                    placeholder="C:\\Users\\name\\.ssh\\id_ed25519"
                    className={fieldClass}
                  />
                  <button
                    type="button"
                    onClick={() => void choosePrivateKey()}
                    className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-border-strong px-2.5 text-[12px] text-fg hover:bg-bg-hover"
                  >
                    <KeyRound size={13} />
                    选择
                  </button>
                </div>
              </label>
              <label className="col-span-2 text-[12px] text-fg-muted">
                私钥口令（如有，仅本次会话）
                <input
                  type="password"
                  value={passphrase}
                  onChange={event => setPassphrase(event.target.value)}
                  className={`${fieldClass} mt-1`}
                />
              </label>
            </>
          ) : (
            <label className="col-span-2 text-[12px] text-fg-muted">
              密码（不会保存）
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                className={`${fieldClass} mt-1`}
              />
            </label>
          )}

          <label className="col-span-2 text-[12px] text-fg-muted">
            远程项目路径
            <input
              value={rootPath}
              onChange={event => setRootPath(event.target.value)}
              placeholder="/home/user/project"
              className={`${fieldClass} mt-1 font-mono`}
            />
          </label>
          {error ? (
            <p className="col-span-2 rounded border border-danger/30 bg-danger/10 px-2.5 py-2 text-[12px] text-danger whitespace-pre-wrap">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={handleClose}
            className="rounded border border-border-strong px-3 py-1.5 text-[13px] text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="rounded bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? '正在连接…' : '连接并打开'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
