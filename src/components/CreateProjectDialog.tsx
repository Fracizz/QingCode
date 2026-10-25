import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  Cloud,
  Folder,
  FolderOpen,
  Globe,
  Laptop,
  Plus,
  Settings2,
  SquareTerminal,
  X,
} from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import {
  browseSshDirectory,
  hasSshSessionSecrets,
  isSshConnectionAlive,
  normalizeRemotePath,
  openSshSession,
  parentRemotePath,
  SSH_CONNECTIONS_CHANGED_EVENT,
  sshConnectionTarget,
  sshRuntimeConfig,
  type SshBrowseEntry,
  type SshSessionSecrets,
} from '../lib/sshWorkspace'
import { isWslPath, WSL_ROOT_PATH, wslSupported } from '../lib/wslWorkspace'
import type { SshConnection } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

/** 源文件夹所在位置：此电脑、本机 WSL，或某个已保存的 SSH 连接。 */
export type ProjectSource = { kind: 'local' } | { kind: 'wsl' } | { kind: 'ssh'; connectionId: string }

type SshPhase = 'auth' | 'connecting' | 'browse'

const fieldClass =
  'w-full rounded border border-border-strong bg-bg px-2.5 py-1.5 text-ui text-fg outline-none focus:border-accent'
const menuItemClass =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ui text-fg hover:bg-bg-hover'

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/** 统一的新建项目入口：本地文件夹、WSL 与 SSH 远程主机共用一个对话框。 */
export default function CreateProjectDialog({ open: visible, onClose, onCreated }: Props) {
  const { t } = useI18n()
  const addProject = useProjectStore(s => s.addProject)
  const addSshProject = useProjectStore(s => s.addSshProject)
  const sshConnections = useProjectStore(s => s.sshConnections)
  const loadSshConnections = useProjectStore(s => s.loadSshConnections)
  const openRemoteConnections = useUIStore(s => s.openRemoteConnections)
  const openRemoteConnectionsForCreate = useUIStore(s => s.openRemoteConnectionsForCreate)

  const [name, setName] = useState('')
  const [source, setSource] = useState<ProjectSource>({ kind: 'local' })
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sshPhase, setSshPhase] = useState<SshPhase>('auth')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [browsePath, setBrowsePath] = useState('/')
  const [pathDraft, setPathDraft] = useState('/')
  const [entries, setEntries] = useState<SshBrowseEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const secretsRef = useRef<SshSessionSecrets>({})
  /** 每次切换来源 / 关闭递增，丢弃过期的连接与浏览结果。 */
  const epochRef = useRef(0)
  const browseRequestRef = useRef(0)
  /** 打开管理页添加主机前的连接 id，用来识别刚保存的新连接。 */
  const knownIdsRef = useRef<Set<string> | null>(null)

  const connection =
    source.kind === 'ssh' ? sshConnections.find(item => item.id === source.connectionId) : undefined
  const showWsl = wslSupported()

  useEffect(() => {
    if (!visible) return
    epochRef.current += 1
    browseRequestRef.current += 1
    knownIdsRef.current = null
    secretsRef.current = {}
    setName('')
    setSource({ kind: 'local' })
    setLocalPath(null)
    setMenuOpen(false)
    setSshPhase('auth')
    setPassword('')
    setPassphrase('')
    setEntries([])
    setSelectedPath(null)
    setBrowsing(false)
    setSubmitting(false)
    setError('')
    void loadSshConnections()
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(timer)
      epochRef.current += 1
      browseRequestRef.current += 1
    }
  }, [visible, loadSshConnections])

  // 管理页里增删连接后同步；从这里发起的「添加远程主机」保存后自动选中新连接。
  useEffect(() => {
    if (!visible) return
    const refresh = () => {
      void loadSshConnections().then(() => {
        const saved = useProjectStore.getState().sshConnections
        const known = knownIdsRef.current
        const added = known ? saved.find(item => !known.has(item.id)) : undefined
        if (added) {
          knownIdsRef.current = null
          void chooseSsh(added)
          return
        }
        setSource(prev =>
          prev.kind === 'ssh' && !saved.some(item => item.id === prev.connectionId)
            ? { kind: 'local' }
            : prev
        )
      })
    }
    window.addEventListener(SSH_CONNECTIONS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(SSH_CONNECTIONS_CHANGED_EVENT, refresh)
    // chooseSsh 每次渲染重建，但只依赖 ref 与 setter，无需进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, loadSshConnections])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [menuOpen])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || useUIStore.getState().remoteConnectionsOpen) return
      event.preventDefault()
      if (menuOpen) setMenuOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible, menuOpen, onClose])

  if (!visible) return null

  const resetSsh = () => {
    epochRef.current += 1
    browseRequestRef.current += 1
    secretsRef.current = {}
    setSshPhase('auth')
    setPassword('')
    setPassphrase('')
    setEntries([])
    setSelectedPath(null)
    setBrowsing(false)
    setError('')
  }

  const pickLocalFolder = async (kind: 'local' | 'wsl') => {
    setMenuOpen(false)
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: kind === 'wsl' ? WSL_ROOT_PATH : (localPath ?? undefined),
        title: kind === 'wsl' ? t('选择 WSL 中的文件夹') : t('选择项目文件夹'),
      })
      if (typeof selected !== 'string') return
      resetSsh()
      setSource({ kind: isWslPath(selected) ? 'wsl' : 'local' })
      setLocalPath(selected)
    } catch (reason) {
      setError(String(reason))
    }
  }

  const loadDirectory = async (connectionId: string, path: string) => {
    const requestId = ++browseRequestRef.current
    setBrowsing(true)
    setError('')
    try {
      const result = await browseSshDirectory(connectionId, normalizeRemotePath(path))
      if (requestId !== browseRequestRef.current) return
      setBrowsePath(result.path)
      setPathDraft(result.path)
      setEntries(result.entries)
      setSelectedPath(null)
    } catch (reason) {
      if (requestId !== browseRequestRef.current) return
      setError(String(reason))
    } finally {
      if (requestId === browseRequestRef.current) setBrowsing(false)
    }
  }

  const connectSsh = async (target: SshConnection, secrets: SshSessionSecrets) => {
    const epoch = ++epochRef.current
    setSshPhase('connecting')
    setError('')
    try {
      const opened = await openSshSession(sshRuntimeConfig(target, secrets))
      if (epoch !== epochRef.current) return
      secretsRef.current = secrets
      setSshPhase('browse')
      await loadDirectory(target.id, opened.homePath)
    } catch (reason) {
      if (epoch !== epochRef.current) return
      setSshPhase('auth')
      setError(String(reason))
    }
  }

  /** 选中 SSH 主机：已在线或无需口令时直接连接，否则先在面板里输入本次会话凭据。 */
  async function chooseSsh(target: SshConnection) {
    setMenuOpen(false)
    resetSsh()
    setLocalPath(null)
    setSource({ kind: 'ssh', connectionId: target.id })
    const epoch = epochRef.current
    const alive = await isSshConnectionAlive(target.id).catch(() => false)
    if (epoch !== epochRef.current) return
    const needsPassword = target.auth_kind === 'password' && !hasSshSessionSecrets(target.id)
    if (alive || !needsPassword) {
      await connectSsh(target, {})
      return
    }
    setSshPhase('auth')
  }

  const submitAuth = () => {
    if (!connection) return
    if (connection.auth_kind === 'password' && !password) {
      setError(t('请输入 SSH 密码。'))
      return
    }
    void connectSsh(connection, {
      password: password || undefined,
      passphrase: passphrase || undefined,
    })
  }

  const addRemoteHost = () => {
    setMenuOpen(false)
    knownIdsRef.current = new Set(sshConnections.map(item => item.id))
    openRemoteConnectionsForCreate()
  }

  const remoteTarget = selectedPath ?? browsePath
  const canCreate =
    !submitting &&
    (source.kind === 'ssh'
      ? sshPhase === 'browse' && !browsing && remoteTarget.startsWith('/')
      : Boolean(localPath))

  const create = async () => {
    if (!canCreate) return
    setSubmitting(true)
    setError('')
    try {
      const created =
        source.kind === 'ssh'
          ? connection
            ? await addSshProject(connection, remoteTarget, name.trim(), secretsRef.current)
            : false
          : await addProject(localPath!, name.trim())
      if (created) onCreated()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSubmitting(false)
    }
  }

  const sourceLabel =
    source.kind === 'ssh'
      ? (connection?.name ?? t('远程主机'))
      : source.kind === 'wsl'
        ? 'WSL'
        : t('此电脑')
  const sourceIcon =
    source.kind === 'ssh' ? (
      <Cloud size={14} />
    ) : source.kind === 'wsl' ? (
      <SquareTerminal size={14} />
    ) : (
      <Laptop size={14} />
    )
  const placeholderName =
    source.kind === 'ssh'
      ? baseName(remoteTarget) || t('项目名称')
      : localPath
        ? baseName(localPath)
        : t('项目名称')

  const sourceMenu = menuOpen ? (
    <div
      role="menu"
      aria-label={t('源文件夹位置')}
      className="menu-enter absolute top-full left-1/2 z-10 mt-1.5 w-64 -translate-x-1/2 rounded-lg border border-border-strong bg-bg-elevated p-1 shadow-2xl shadow-black/50"
    >
      <MenuItem
        icon={<Laptop size={14} />}
        label={t('此电脑')}
        checked={source.kind === 'local'}
        onSelect={() => void pickLocalFolder('local')}
      />
      <p className="px-2 pt-2 pb-1 text-ui-sm text-fg-dim">{t('远程设备')}</p>
      {showWsl ? (
        <MenuItem
          icon={<SquareTerminal size={14} />}
          label="WSL"
          checked={source.kind === 'wsl'}
          onSelect={() => void pickLocalFolder('wsl')}
        />
      ) : null}
      {sshConnections.map(item => (
        <MenuItem
          key={item.id}
          icon={<Cloud size={14} />}
          label={item.name}
          detail={sshConnectionTarget(item)}
          checked={source.kind === 'ssh' && source.connectionId === item.id}
          onSelect={() => void chooseSsh(item)}
        />
      ))}
      <MenuItem icon={<Plus size={14} />} label={t('添加远程主机')} onSelect={addRemoteHost} />
      {sshConnections.length > 0 ? (
        <>
          <div className="my-1 border-t border-border-strong/80" />
          <MenuItem
            icon={<Settings2 size={14} />}
            label={t('管理远程连接…')}
            onSelect={() => {
              setMenuOpen(false)
              openRemoteConnections()
            }}
          />
        </>
      ) : null}
    </div>
  ) : null

  const sourceTrigger = (
    <div ref={menuRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(value => !value)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ui text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        {sourceIcon}
        <span className="max-w-[220px] truncate font-semibold text-fg">{sourceLabel}</span>
        <ChevronDown size={14} />
      </button>
      {sourceMenu}
    </div>
  )

  const renderLocalBody = () =>
    localPath ? (
      <div className="flex items-center gap-2 px-3 py-3">
        <FolderOpen size={16} className="flex-shrink-0 text-fg-dim" />
        <span className="min-w-0 flex-1 truncate font-mono text-ui text-fg">{localPath}</span>
        <button
          type="button"
          onClick={() => void pickLocalFolder(source.kind === 'wsl' ? 'wsl' : 'local')}
          className="flex-shrink-0 rounded border border-border-strong px-2.5 py-1 text-ui-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {t('更换')}
        </button>
      </div>
    ) : (
      <div className="flex min-h-[120px] flex-col items-center justify-center gap-1 px-3 py-6">
        <button
          type="button"
          onClick={() => void pickLocalFolder(source.kind === 'wsl' ? 'wsl' : 'local')}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-ui-lg text-fg hover:bg-bg-hover"
        >
          <Plus size={15} className="text-fg-muted" />
          {source.kind === 'wsl' ? t('在 WSL 中选择文件夹') : t('在此电脑上选择文件夹')}
        </button>
        <p className="text-ui-sm text-fg-dim">{t('点击上方来源可切换到 WSL 或远程主机')}</p>
      </div>
    )

  const renderSshBody = () => {
    if (!connection) return null
    if (sshPhase !== 'browse') {
      const connecting = sshPhase === 'connecting'
      return (
        <div className="flex flex-col gap-3 px-3 py-4">
          <div className="flex items-center gap-2 font-mono text-ui-sm text-fg-muted">
            <Globe size={13} className="flex-shrink-0 text-fg-dim" />
            <span className="min-w-0 truncate">{sshConnectionTarget(connection)}</span>
          </div>
          {connecting ? (
            <p className="py-4 text-center text-ui text-fg-muted">{t('正在连接…')}</p>
          ) : (
            <form
              className="flex flex-col gap-2"
              onSubmit={event => {
                event.preventDefault()
                submitAuth()
              }}
            >
              <label className="text-ui text-fg-muted">
                {connection.auth_kind === 'password'
                  ? t('密码（本次会话，不会保存）')
                  : t('私钥口令（如有，仅本次会话）')}
                <input
                  type="password"
                  autoFocus
                  value={connection.auth_kind === 'password' ? password : passphrase}
                  onChange={event =>
                    connection.auth_kind === 'password'
                      ? setPassword(event.target.value)
                      : setPassphrase(event.target.value)
                  }
                  className={`${fieldClass} mt-1`}
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90"
                >
                  {t('连接')}
                </button>
              </div>
            </form>
          )}
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1.5 p-2">
        <div className="flex gap-1.5">
          <Tooltip label={t('上级目录')} side="bottom">
            <button
              type="button"
              disabled={browsing || browsePath === '/'}
              aria-label={t('上级目录')}
              onClick={() => void loadDirectory(connection.id, parentRemotePath(browsePath))}
              className="inline-flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center rounded border border-border-strong text-fg hover:bg-bg-hover disabled:opacity-40"
            >
              <ArrowUp size={14} />
            </button>
          </Tooltip>
          <input
            aria-label={t('远程路径')}
            value={pathDraft}
            onChange={event => setPathDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault()
              void loadDirectory(connection.id, pathDraft)
            }}
            className={`${fieldClass} min-w-0 flex-1 font-mono`}
          />
        </div>
        <div
          role="listbox"
          aria-label={t('远程文件夹')}
          className="overflow-y-auto rounded border border-border-strong bg-bg"
          style={{ height: 220 }}
        >
          {browsing ? (
            <p className="px-2.5 py-4 text-center text-ui text-fg-muted">{t('正在读取目录…')}</p>
          ) : entries.length === 0 ? (
            <p className="px-2.5 py-4 text-center text-ui text-fg-muted">
              {t('此目录下没有子文件夹')}
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
                    void loadDirectory(connection.id, entry.path)
                  }}
                  className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-ui ${
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
        <p className="truncate px-0.5 text-ui-sm text-fg-dim">
          {t('将添加：')}
          <span className="font-mono text-fg-muted">{remoteTarget}</span>
        </p>
      </div>
    )
  }

  return (
    <ModalOverlay onDismiss={onClose} zIndex="z-[115]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        className="ui-font-scaled modal-content-enter relative flex max-h-[85vh] w-full max-w-[520px] flex-col rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between px-5 pt-4 pb-3">
          <h2 id="create-project-title" className="text-ui-xl font-semibold text-fg">
            {t('创建项目')}
          </h2>
          <Tooltip label={t('关闭')} side="left">
            <button
              type="button"
              onClick={onClose}
              aria-label={t('关闭')}
              className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
            >
              <X size={18} />
            </button>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
          <label className="flex items-stretch overflow-hidden rounded-md border border-border-strong bg-bg focus-within:border-accent">
            <span className="flex w-10 flex-shrink-0 items-center justify-center border-r border-border-strong text-fg-muted">
              <Folder size={15} />
            </span>
            <input
              ref={nameRef}
              aria-label={t('项目名称')}
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void create()
              }}
              placeholder={placeholderName}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-ui text-fg outline-none"
            />
          </label>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ui font-semibold text-fg">{t('源文件夹')}</span>
              <span className="flex items-center gap-1 text-ui-sm text-fg-dim">
                {t('位置')}
                {sourceTrigger}
              </span>
            </div>
            <div className="rounded-md border border-border-strong bg-bg/40">
              {source.kind === 'ssh' ? renderSshBody() : renderLocalBody()}
            </div>
          </div>

          {error ? (
            <p className="whitespace-pre-wrap rounded border border-danger/30 bg-danger/10 px-2.5 py-2 text-ui text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-shrink-0 justify-end gap-2 border-t border-border-strong px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border-strong px-3 py-1.5 text-ui text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            {t('取消')}
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={() => void create()}
            className="rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-50"
          >
            {submitting ? t('正在创建…') : t('创建项目')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function MenuItem({
  icon,
  label,
  detail,
  checked,
  onSelect,
}: {
  icon: ReactNode
  label: string
  detail?: string
  checked?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={Boolean(checked)}
      onClick={onSelect}
      className={menuItemClass}
    >
      <span className="flex-shrink-0 text-fg-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">
        {label}
        {detail ? <span className="ml-1.5 font-mono text-ui-2xs text-fg-dim">{detail}</span> : null}
      </span>
      {checked ? <Check size={14} className="flex-shrink-0 text-fg" /> : null}
    </button>
  )
}
