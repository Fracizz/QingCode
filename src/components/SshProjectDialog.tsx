import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, Globe, KeyRound, Server, X } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import {
  browseSshDirectory,
  disconnectSshSession,
  hasSshSessionSecrets,
  isSshConnectionAlive,
  NEW_SSH_CONNECTION_ID,
  normalizeRemotePath,
  openSshSession,
  parentRemotePath,
  probeSshHost,
  sshConnectionLabel,
  sshConnectionTarget,
  sshRuntimeConfig,
  type SshBrowseEntry,
  type SshSessionSecrets,
} from '../lib/sshWorkspace'
import type { SshConnection } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  onAdded: () => void
}

type AuthKind = SshConnection['auth_kind']
type DialogStep = 'connect' | 'browse'

interface PendingSession {
  connection: SshConnection
  secrets: SshSessionSecrets
  reuseExisting: boolean
}

export default function SshProjectDialog({ open: visible, onClose, onAdded }: Props) {
  const addSshProject = useProjectStore(state => state.addSshProject)
  const sshConnections = useProjectStore(state => state.sshConnections)
  const loadSshConnections = useProjectStore(state => state.loadSshConnections)
  const saveSshConnection = useProjectStore(state => state.saveSshConnection)
  const [step, setStep] = useState<DialogStep>('connect')
  const [connectionId, setConnectionId] = useState(NEW_SSH_CONNECTION_ID)
  const [connectionName, setConnectionName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authKind, setAuthKind] = useState<AuthKind>('privateKey')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [browsePath, setBrowsePath] = useState('/')
  const [pathDraft, setPathDraft] = useState('/')
  const [entries, setEntries] = useState<SshBrowseEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const pendingRef = useRef<PendingSession | null>(null)
  const closedRef = useRef(false)
  const selectedConnection = sshConnections.find(item => item.id === connectionId)
  const creatingConnection = connectionId === NEW_SSH_CONNECTION_ID

  useEffect(() => {
    if (!visible) return
    closedRef.current = false
    setStep('connect')
    setError('')
    setSubmitting(false)
    setBrowsing(false)
    setEntries([])
    setSelectedPath(null)
    setProjectName('')
    setPassword('')
    setPassphrase('')
    let cancelled = false
    void loadSshConnections().then(() => {
      if (cancelled) return
      const saved = useProjectStore.getState().sshConnections
      setConnectionId(saved[0]?.id ?? NEW_SSH_CONNECTION_ID)
    })
    return () => {
      cancelled = true
    }
  }, [visible, loadSshConnections])

  const discardSession = () => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending || pending.reuseExisting) return
    void disconnectSshSession(pending.connection.id).catch(() => {})
  }

  const handleClose = () => {
    closedRef.current = true
    discardSession()
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

  const loadDirectory = async (connectionId: string, path: string) => {
    setBrowsing(true)
    setError('')
    try {
      const result = await browseSshDirectory(connectionId, normalizeRemotePath(path))
      if (closedRef.current) return
      setBrowsePath(result.path)
      setPathDraft(result.path)
      setEntries(result.entries)
      setSelectedPath(null)
    } catch (reason) {
      if (closedRef.current) return
      setError(String(reason))
    } finally {
      if (!closedRef.current) setBrowsing(false)
    }
  }

  const beginBrowse = async (
    connection: SshConnection,
    secrets: SshSessionSecrets,
    reuseExisting: boolean,
    homePath: string
  ) => {
    pendingRef.current = { connection, secrets, reuseExisting }
    setProjectName('')
    setStep('browse')
    await loadDirectory(connection.id, homePath)
  }

  const connectExisting = async (connection: SshConnection) => {
    const secrets: SshSessionSecrets = {
      password: password || undefined,
      passphrase: passphrase || undefined,
    }
    if (
      connection.auth_kind === 'password' &&
      !secrets.password &&
      !hasSshSessionSecrets(connection.id) &&
      !(await isSshConnectionAlive(connection.id))
    ) {
      setError('请输入 SSH 密码。')
      return
    }
    const opened = await openSshSession({
      ...sshRuntimeConfig(connection, secrets),
    })
    if (closedRef.current) return
    await beginBrowse(connection, secrets, true, opened.homePath)
  }

  const connectNew = async () => {
    const normalizedHost = host.trim()
    const normalizedUser = username.trim()
    const normalizedPort = Number.parseInt(port, 10)
    if (!normalizedHost || !normalizedUser) {
      setError('请填写主机和用户名。')
      return
    }
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setError('SSH 端口必须在 1–65535 之间。')
      return
    }
    if (authKind === 'password' && !password) {
      setError('请输入 SSH 密码。')
      return
    }

    const id = crypto.randomUUID()
    const secrets: SshSessionSecrets = {
      password: password || undefined,
      passphrase: passphrase || undefined,
    }
    const runtimeConfig = {
      id,
      host: normalizedHost,
      port: normalizedPort,
      username: normalizedUser,
      authKind,
      privateKeyPath: privateKeyPath.trim() || undefined,
      ...secrets,
    }
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

    const opened = await openSshSession({
      ...runtimeConfig,
      hostKeyFingerprint: fingerprint,
    })
    if (closedRef.current) {
      void disconnectSshSession(id).catch(() => {})
      return
    }

    const now = Date.now()
    const connection: SshConnection = {
      id,
      name: connectionName.trim() || normalizedHost,
      host: normalizedHost,
      port: normalizedPort,
      username: normalizedUser,
      auth_kind: authKind,
      private_key_path: privateKeyPath.trim() || undefined,
      host_key_fingerprint: fingerprint,
      created_at: now,
      updated_at: now,
    }
    await saveSshConnection(connection)
    if (closedRef.current) {
      void disconnectSshSession(id).catch(() => {})
      return
    }
    await beginBrowse(connection, secrets, false, opened.homePath)
  }

  const connect = async () => {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      if (!creatingConnection && selectedConnection) {
        await connectExisting(selectedConnection)
        return
      }
      await connectNew()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSubmitting(false)
    }
  }

  const backToConnection = () => {
    discardSession()
    setStep('connect')
    setError('')
  }

  const addProject = async () => {
    const pending = pendingRef.current
    if (!pending || submitting) return
    const rootPath = selectedPath ?? browsePath
    if (!rootPath.startsWith('/')) {
      setError('请选择以 / 开头的远程项目路径。')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const added = await addSshProject(
        pending.connection,
        rootPath,
        projectName.trim(),
        pending.secrets
      )
      if (closedRef.current) return
      if (added) {
        pendingRef.current = null
        onAdded()
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSubmitting(false)
    }
  }

  const fieldClass =
    'w-full rounded border border-border-strong bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent'
  const pathFieldClass = `${fieldClass} font-mono`
  const labelClass = 'text-[13px] text-fg-muted'
  const helpClass = 'text-ui-sm leading-5 text-fg-muted'
  const valueBoxClass =
    'mt-1 flex items-center gap-2 rounded border border-border-strong bg-bg px-2.5 py-1.5 font-mono text-[13px] text-fg-muted'
  const hostLabel = pendingRef.current
    ? sshConnectionTarget(pendingRef.current.connection)
    : sshConnectionTarget({
        username: username.trim() || 'user',
        host: host.trim() || 'host',
        port: Number.parseInt(port, 10) || 22,
      })
  const title = step === 'browse' ? '选择远程项目' : '打开 SSH 项目'
  const targetPath = selectedPath ?? browsePath

  return (
    <ModalOverlay onDismiss={handleClose} zIndex="z-[120]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-project-title"
        className="ui-font-scaled modal-content-enter relative flex w-full max-w-[480px] shrink-0 flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50 max-h-[80vh]"
        style={step === 'browse' ? { width: 480, maxWidth: 'calc(100vw - 2rem)' } : undefined}
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border-strong px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[14px] font-semibold text-fg">
            <Server size={16} className="text-fg-muted" />
            <h2 id="ssh-project-title">{title}</h2>
          </div>
          <Tooltip label="关闭" side="left">
            <button
              type="button"
              onClick={handleClose}
              className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </Tooltip>
        </div>

        {step === 'connect' ? (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-x-3 gap-y-3 overflow-y-auto px-4 py-4">
              <label className={`col-span-2 ${labelClass}`}>
                SSH 连接
                <select
                  value={connectionId}
                  onChange={event => {
                    setConnectionId(event.target.value)
                    setError('')
                    setPassword('')
                    setPassphrase('')
                  }}
                  className={`${fieldClass} mt-1`}
                >
                  {sshConnections.map(connection => (
                    <option key={connection.id} value={connection.id}>
                      {sshConnectionLabel(connection)}
                    </option>
                  ))}
                  <option value={NEW_SSH_CONNECTION_ID}>新建连接…</option>
                </select>
              </label>
              <p className={`col-span-2 ${helpClass}`}>
                SSH 连接与项目分开保存。同一连接可以继续打开多个远程项目。
              </p>
              {creatingConnection ? (
                <>
                  <label className={`col-span-2 ${labelClass}`}>
                    连接名称
                    <input
                      value={connectionName}
                      onChange={event => setConnectionName(event.target.value)}
                      placeholder="默认使用主机名"
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                  <label className={labelClass}>
                    主机
                    <input
                      value={host}
                      onChange={event => setHost(event.target.value)}
                      placeholder="192.168.1.10"
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                  <label className={labelClass}>
                    端口
                    <input
                      value={port}
                      onChange={event => setPort(event.target.value)}
                      inputMode="numeric"
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                  <label className={labelClass}>
                    用户名
                    <input
                      value={username}
                      onChange={event => setUsername(event.target.value)}
                      placeholder="root"
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                  <label className={labelClass}>
                    认证方式
                    <select
                      value={authKind}
                      onChange={event => setAuthKind(event.target.value as AuthKind)}
                      className={`${fieldClass} mt-1`}
                    >
                      <option value="privateKey">私钥（推荐，WSL 无需密码）</option>
                      <option value="password">密码（仅本次会话）</option>
                    </select>
                  </label>

                  {authKind === 'privateKey' ? (
                    <>
                      <label className={`col-span-2 ${labelClass}`}>
                        私钥文件（可选）
                        <div className="mt-1 flex gap-2">
                          <input
                            value={privateKeyPath}
                            onChange={event => setPrivateKeyPath(event.target.value)}
                            placeholder="留空则使用 ~/.ssh/id_ed25519 等默认密钥"
                            className={pathFieldClass}
                          />
                          <button
                            type="button"
                            onClick={() => void choosePrivateKey()}
                            className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-border-strong px-2.5 text-[13px] text-fg hover:bg-bg-hover"
                          >
                            <KeyRound size={13} />
                            选择
                          </button>
                        </div>
                      </label>
                      <p className={`col-span-2 ${helpClass}`}>
                        WSL 通常没有登录密码。选私钥即可；未指定文件时会尝试本机默认密钥。
                      </p>
                      <label className={`col-span-2 ${labelClass}`}>
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
                    <label className={`col-span-2 ${labelClass}`}>
                      密码（不会保存）
                      <input
                        type="password"
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        className={`${fieldClass} mt-1`}
                      />
                    </label>
                  )}
                </>
              ) : (
                <>
                  <div className={`col-span-2 ${labelClass}`}>
                    已保存的主机
                    <div className={valueBoxClass}>
                      <Globe size={14} className="text-fg-dim" />
                      <span className="min-w-0 truncate">
                        {selectedConnection ? sshConnectionTarget(selectedConnection) : ''}
                      </span>
                    </div>
                  </div>
                  {selectedConnection?.auth_kind === 'password' ? (
                    <label className={`col-span-2 ${labelClass}`}>
                      密码（本次会话，不会保存）
                      <input
                        type="password"
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        className={`${fieldClass} mt-1`}
                      />
                    </label>
                  ) : (
                    <label className={`col-span-2 ${labelClass}`}>
                      私钥口令（如有，仅本次会话）
                      <input
                        type="password"
                        value={passphrase}
                        onChange={event => setPassphrase(event.target.value)}
                        className={`${fieldClass} mt-1`}
                      />
                    </label>
                  )}
                </>
              )}
              {error ? (
                <p className="col-span-2 rounded border border-danger/30 bg-danger/10 px-2.5 py-2 text-[13px] text-danger whitespace-pre-wrap">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-border-strong px-4 py-2.5">
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
                onClick={() => void connect()}
                className="rounded bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {submitting ? '正在连接…' : '连接'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3 overflow-hidden px-4 py-4">
              <label className={labelClass}>
                项目名称
                <div className="relative mt-1">
                  <Folder
                    size={13}
                    className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-dim"
                  />
                  <input
                    value={projectName}
                    onChange={event => setProjectName(event.target.value)}
                    placeholder="默认使用目录名"
                    className={`${fieldClass} pl-7`}
                  />
                </div>
              </label>

              <div className={labelClass}>
                远程主机
                <div className={valueBoxClass}>
                  <Globe size={13} className="text-fg-dim" />
                  <span className="min-w-0 truncate">{hostLabel}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className={labelClass}>源文件夹</div>
                <div className="flex gap-1.5">
                  <Tooltip label="上级目录" side="bottom">
                    <button
                      type="button"
                      disabled={browsing || browsePath === '/'}
                      aria-label="上级目录"
                      onClick={() => {
                        const pending = pendingRef.current
                        if (!pending) return
                        void loadDirectory(pending.connection.id, parentRemotePath(browsePath))
                      }}
                      className="inline-flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded border border-border-strong text-fg hover:bg-bg-hover disabled:opacity-40"
                    >
                      <ArrowUp size={14} />
                    </button>
                  </Tooltip>
                  <input
                    aria-label="源文件夹"
                    value={pathDraft}
                    onChange={event => setPathDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return
                      const pending = pendingRef.current
                      if (!pending) return
                      void loadDirectory(pending.connection.id, pathDraft)
                    }}
                    className={`${pathFieldClass} min-w-0 flex-1`}
                  />
                </div>
                <div
                  role="listbox"
                  aria-label="远程文件夹"
                  className="overflow-y-auto rounded border border-border-strong bg-bg"
                  style={{ height: 240 }}
                >
                  {browsing ? (
                    <p className="px-2.5 py-4 text-center text-[13px] text-fg-muted">
                      正在读取目录…
                    </p>
                  ) : entries.length === 0 ? (
                    <p className="px-2.5 py-4 text-center text-[13px] text-fg-muted">
                      此目录下没有子文件夹
                    </p>
                  ) : (
                    entries.map(entry => {
                      const selected = selectedPath === entry.path
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => setSelectedPath(entry.path)}
                          onDoubleClick={event => {
                            event.preventDefault()
                            event.stopPropagation()
                            const pending = pendingRef.current
                            if (!pending) return
                            void loadDirectory(pending.connection.id, entry.path)
                          }}
                          className={`flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] ${
                            selected ? 'bg-bg-active text-fg' : 'text-fg hover:bg-bg-hover'
                          }`}
                        >
                          <Folder size={13} className="flex-shrink-0 text-fg-dim" />
                          <span className="min-w-0 truncate">{entry.name}</span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
              {error ? (
                <p className="rounded border border-danger/30 bg-danger/10 px-2.5 py-2 text-[13px] text-danger whitespace-pre-wrap">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-strong px-4 py-2.5">
              <button
                type="button"
                onClick={backToConnection}
                className="mr-auto rounded px-3 py-1.5 text-[13px] text-fg-muted hover:bg-bg-hover hover:text-fg"
              >
                返回连接
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="rounded border border-border-strong px-3 py-1.5 text-[13px] text-fg-muted hover:bg-bg-hover hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                disabled={submitting || browsing || !targetPath.startsWith('/')}
                onClick={() => void addProject()}
                className="rounded bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {submitting ? '正在添加…' : '添加项目'}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalOverlay>
  )
}
