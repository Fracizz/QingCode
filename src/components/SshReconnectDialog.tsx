import { useEffect, useRef, useState } from 'react'
import { KeyRound, RefreshCw, Server, X } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import type { Project, SshConnection } from '../types'
import { getSshConnection, upsertSshConnection } from '../lib/projectRepository'
import {
  connectSshWorkspace,
  SSH_RECONNECT_REQUEST_EVENT,
  type SshSessionSecrets,
} from '../lib/sshWorkspace'
import { useProjectStore } from '../store/projectStore'
import { directAgentApi, directAgentErrorKey, type DirectAgentInfo } from '../lib/directAgent'
import { useI18n } from '../lib/i18n'

export default function SshReconnectDialog() {
  const { t } = useI18n()
  const [project, setProject] = useState<Project | null>(null)
  const [connection, setConnection] = useState<SshConnection | null>(null)
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [directInfo, setDirectInfo] = useState<DirectAgentInfo | null>(null)
  const [checkingProfile, setCheckingProfile] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const requested = (event as CustomEvent<Project>).detail
      const request = ++requestRef.current
      setProject(requested)
      setConnection(null)
      setPassword('')
      setPassphrase('')
      setError('')
      setDirectInfo(null)
      setCheckingProfile(true)
      if (!requested.connection_id) {
        setError('SSH 项目缺少连接配置。')
        setCheckingProfile(false)
        return
      }
      void Promise.all([
        getSshConnection(requested.connection_id),
        directAgentApi.info(requested.connection_id).catch(() => null),
      ])
        .then(([value, info]) => {
          if (request !== requestRef.current) return
          setConnection(value)
          setDirectInfo(info)
          setPrivateKeyPath(value?.private_key_path ?? '')
          if (!value) setError('SSH 连接配置不存在。')
        })
        .catch(reason => {
          if (request === requestRef.current) setError(String(reason))
        })
        .finally(() => {
          if (request === requestRef.current) setCheckingProfile(false)
        })
    }
    window.addEventListener(SSH_RECONNECT_REQUEST_EVENT, handleRequest)
    return () => {
      requestRef.current += 1
      window.removeEventListener(SSH_RECONNECT_REQUEST_EVENT, handleRequest)
    }
  }, [])

  if (!project) return null

  const close = () => {
    if (!loading) {
      requestRef.current += 1
      setProject(null)
    }
  }

  const choosePrivateKey = async () => {
    const selected = await open({ directory: false, multiple: false, title: '选择 SSH 私钥' })
    if (typeof selected === 'string') setPrivateKeyPath(selected)
  }

  const reconnect = async () => {
    if (!connection || loading || checkingProfile) return
    if (!directInfo?.enabled && connection.auth_kind === 'password' && !password) {
      setError('请输入 SSH 密码。')
      return
    }
    if (!directInfo?.enabled && connection.auth_kind === 'privateKey' && !privateKeyPath.trim()) {
      setError('请选择 SSH 私钥文件。')
      return
    }
    setLoading(true)
    setError('')
    const secrets: SshSessionSecrets = directInfo?.enabled ? {} : {
      password: password || undefined,
      passphrase: passphrase || undefined,
    }
    try {
      const nextConnection = directInfo?.enabled ? connection : {
        ...connection,
        private_key_path: privateKeyPath.trim() || undefined,
        updated_at: Date.now(),
      }
      if (nextConnection.private_key_path !== connection.private_key_path) {
        await upsertSshConnection(nextConnection)
      }
      await connectSshWorkspace(project, nextConnection, secrets)
      const switched = await useProjectStore.getState().switchProject(project)
      if (switched) setProject(null)
    } catch (reason) {
      setError(directInfo?.enabled ? t(directAgentErrorKey(reason)) : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const fieldClass =
    'w-full rounded border border-border-strong bg-bg px-2.5 py-1.5 text-ui text-fg outline-none focus:border-accent'

  return (
    <ModalOverlay onDismiss={close} zIndex="z-[125]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-reconnect-title"
        className="ui-font-scaled modal-content-enter w-full max-w-[480px] overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Server size={17} className="text-accent" />
          <h2 id="ssh-reconnect-title" className="flex-1 text-ui-lg font-semibold text-fg">
            {directInfo?.enabled ? t('重新连接 Agent 项目') : '重新连接 SSH 项目'}
          </h2>
          <Tooltip label="关闭" side="left">
            <button
              type="button"
              onClick={close}
              disabled={loading}
              className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="space-y-3 px-4 py-4">
          <div className="rounded border border-border bg-bg px-3 py-2 text-ui-sm text-fg-muted">
            <div className="font-medium text-fg">{project.name}</div>
            <div className="mt-1 font-mono">
              {directInfo?.enabled ? `${directInfo.host}:${directInfo.port} · TLS` : connection
                ? `${connection.username}@${connection.host}:${connection.port}`
                : '正在读取连接配置…'}
            </div>
            <div className="mt-0.5 truncate font-mono">{project.root_path ?? project.path}</div>
          </div>
          {checkingProfile ? <p className="text-ui-sm text-fg-muted">{t('正在检查连接方式…')}</p> : directInfo?.enabled ? <p className="text-ui-sm text-fg-muted">{t('使用已保存的 Agent 配对凭据连接，无需 SSH 密码。请确认远端服务正在运行，并开放 TCP {port}。', { port: directInfo.port })}</p> : connection?.auth_kind === 'password' ? (
            <label className="block text-ui-sm text-fg-muted">
              密码（仅本次会话）
              <input
                autoFocus
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void reconnect()
                }}
                className={`${fieldClass} mt-1`}
              />
            </label>
          ) : connection ? (
            <>
              <label className="block text-ui-sm text-fg-muted">
                私钥文件
                <div className="mt-1 flex gap-2">
                  <input
                    value={privateKeyPath}
                    onChange={event => setPrivateKeyPath(event.target.value)}
                    className={fieldClass}
                  />
                  <button
                    type="button"
                    onClick={() => void choosePrivateKey()}
                    className="inline-flex items-center gap-1 rounded border border-border-strong px-2.5 text-ui-sm text-fg hover:bg-bg-hover"
                  >
                    <KeyRound size={13} />
                    选择
                  </button>
                </div>
              </label>
              <label className="block text-ui-sm text-fg-muted">
                私钥口令（如有，仅本次会话）
                <input
                  autoFocus
                  type="password"
                  value={passphrase}
                  onChange={event => setPassphrase(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void reconnect()
                  }}
                  className={`${fieldClass} mt-1`}
                />
              </label>
            </>
          ) : null}
          {error ? (
            <p className="rounded border border-danger/30 bg-danger/10 px-2.5 py-2 text-ui-sm whitespace-pre-wrap text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={close}
            disabled={loading}
            className="rounded border border-border-strong px-3 py-1.5 text-ui text-fg-muted hover:bg-bg-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!connection || loading || checkingProfile}
            onClick={() => void reconnect()}
            className="inline-flex items-center gap-1.5 rounded bg-action px-3 py-1.5 text-ui text-on-action hover:bg-action/90 disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
            {loading ? '正在连接…' : '重新连接'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
