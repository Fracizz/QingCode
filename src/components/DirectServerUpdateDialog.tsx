import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import {
  directServerUpdateApi,
  updatePhaseLabels,
  validServerUpdatePackage as validPackage,
  type DirectServerUpdateApi,
  type UpdatePhase,
} from '../lib/directServerUpdate'
import type { ServerPackageInfo } from '../lib/sshServerRecovery'
import { directAgentSshCandidates } from '../lib/directAgent'
import { hydrateSshSecrets, sshConnectionIdFromUri, sshRuntimeConfig, sshSecretsFor } from '../lib/sshWorkspace'
import { parseSshServerState, type DeferredUpgrade } from '../lib/sshServerStatus'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import ModalOverlay from './ModalOverlay'
import ServerOperationProgress from './ServerOperationProgress'

const field = 'mt-1 w-full min-w-0 rounded border border-dialog-border bg-dialog-input px-3 py-1.5 text-fg'

type Props = { rootUri: string; api?: DirectServerUpdateApi; confirmedUpgrade?: DeferredUpgrade; onClose?: () => void }

export default function DirectServerUpdateDialog(props: Props) {
  return <UpdateDialog key={props.rootUri} {...props} />
}

function UpdateDialog({ rootUri, api = directServerUpdateApi, confirmedUpgrade, onClose }: Props) {
  const { t } = useI18n()
  const id = useId()
  const connections = useProjectStore(s => s.sshConnections)
  const pushToast = useProjectStore(s => s.pushToast)
  const connectionId = sshConnectionIdFromUri(rootUri)
  const direct = connections.find(connection => connection.id === connectionId)
  const candidates = directAgentSshCandidates(
    connections,
    direct?.agentEndpoint?.host ?? direct?.host ?? ''
  )
  const [sshId, setSshId] = useState('')
  const [secret, setSecret] = useState('')
  const [working, setWorking] = useState<'choose' | 'prepare' | 'update' | null>(null)
  const busy = working !== null
  const [mode, setMode] = useState<'automatic' | 'offline'>('automatic')
  const [directory, setDirectory] = useState('')
  const [info, setInfo] = useState<ServerPackageInfo | null>(null)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<UpdatePhase>('connecting')
  const [startedAt, setStartedAt] = useState(0)
  const pending = useRef(false)
  const automaticallyPrepared = useRef(false)
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    []
  )
  const invalidate = () => {
    generation.current++
    setInfo(null)
    setError('')
  }
  const ssh =
    candidates.find(connection => connection.id === sshId) ??
    candidates.find(connection => connection.id === connectionId) ??
    candidates[0]
  const dismiss = onClose ?? (() => useUIStore.setState({ serverUpdateRootUri: null }))
  const close = () => {
    if (!pending.current) dismiss()
  }
  const target = () => ({
    rootUri,
    sshConnectionId: ssh!.id,
    config: sshRuntimeConfig(ssh!, {
      ...sshSecretsFor(ssh!.id),
      ...(secret
        ? ssh!.auth_kind === 'password'
          ? { password: secret }
          : { passphrase: secret }
        : {}),
    }),
  })
  const chooseDirectory = async () => {
    if (pending.current) return
    pending.current = true
    setWorking('choose')
    const request = ++generation.current
    try {
      const selected = await api.chooseDirectory()
      if (request === generation.current && selected) {
        setDirectory(selected)
        setInfo(null)
        setError('')
      }
    } catch (reason) {
      if (request === generation.current) setError(String(reason))
    } finally {
      pending.current = false
      if (request === generation.current) setWorking(null)
    }
  }
  const performUpdate = async (prepared: ServerPackageInfo & { directory: string }, request: number) => {
    setWorking('update')
    setPhase('checkingPackage')
    const value = await api.update({ ...target(), packageDirectory: prepared.directory, ...(confirmedUpgrade && { confirmedUpgrade }) }, value => {
      if (request === generation.current) setPhase(value)
    })
    if (request !== generation.current) return
    const state = parseSshServerState(value)
    if (state?.phase !== 'readyServer' || state.transport !== 'agent')
      throw new Error(state?.reason ?? t('远端服务尚未就绪'))
    if (confirmedUpgrade && state.version !== confirmedUpgrade.targetVersion)
      throw new Error(t('远端服务尚未更新到目标版本，请刷新状态。'))
    pushToast('success', t('已更新远端服务，请重新新建终端或重试原操作'))
    dismiss()
  }
  const prepare = async (automatic = false) => {
    if (pending.current || !ssh || (mode === 'offline' && !directory)) return
    pending.current = true
    setWorking('prepare')
    setPhase('connecting')
    setError('')
    setInfo(null)
    const request = ++generation.current
    let localPackage = true
    let updating = false
    try {
      await hydrateSshSecrets(ssh.id)
      if (request !== generation.current) return
      const value = await api.prepare(
        {
          ...target(),
          packageSource: mode === 'automatic' ? { mode, ...(automatic ? { allowDownload: false } : {}) } : { mode, directory },
        },
        value => {
          if (value === 'downloading') localPackage = false
          if (request === generation.current) setPhase(value)
        }
      )
      if (request !== generation.current) return
      setInfo(value)
      if (localPackage && validPackage(value)) {
        updating = true
        await performUpdate(value, request)
      }
    } catch (reason) {
      if (request === generation.current) {
        setError(String(reason))
        if (updating) setInfo(null)
      }
    } finally {
      pending.current = false
      if (request === generation.current) {
        setWorking(null)
        if (updating) setSecret('')
      }
    }
  }
  useEffect(() => {
    if (automaticallyPrepared.current || !ssh || mode !== 'automatic') return
    let cancelled = false
    // Defer past StrictMode's effect replay so it cannot invalidate an in-flight request.
    queueMicrotask(() => {
      if (cancelled || automaticallyPrepared.current || pending.current) return
      automaticallyPrepared.current = true
      setStartedAt(Date.now())
      void prepare(true)
    })
    return () => { cancelled = true }
  })
  const update = async () => {
    if (pending.current || !ssh || !validPackage(info)) return
    pending.current = true
    setWorking('update')
    setPhase('checkingPackage')
    setError('')
    const request = ++generation.current
    try {
      await performUpdate(info, request)
    } catch (reason) {
      if (request === generation.current) {
        setError(String(reason))
        setInfo(null)
      }
    } finally {
      pending.current = false
      if (request === generation.current) {
        setWorking(null)
        setSecret('')
      }
    }
  }
  return (
    <ModalOverlay onDismiss={close} zIndex="z-[130]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-impact`}
        aria-busy={busy}
        className="flex max-h-[min(85dvh,48rem)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-dialog-border bg-dialog text-ui text-fg shadow-elevation-3"
      >
        <h2
          id={`${id}-title`}
          className="shrink-0 bg-dialog-chrome px-5 py-3 text-ui-lg font-semibold"
        >
          {t('通过 SSH 更新远端服务')}
        </h2>
        <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-4">
          <p className="break-all font-medium">
            {direct?.name} · {direct?.agentEndpoint?.host ?? direct?.host}
          </p>
          <p id={`${id}-impact`} className="text-ui-sm text-warn">
            {confirmedUpgrade ? t('强制更新将替换旧服务并结束其托管的终端。') : t(
              '将安装与当前客户端匹配的远端服务并替换直连入口。旧版服务若与当前客户端兼容且仍有运行中的终端，会继续托管并可接回，全部结束后的下次连接再切换到新版本；不兼容时会被替换，其托管的终端随之结束。更新期间连接会短暂中断，可能影响同一远端用户下的其他项目。'
            )}
          </p>
          <details className="text-ui-sm text-fg-muted">
            <summary className="cursor-pointer text-fg">{t('更新说明')}</summary>
            <p className="mt-2">
              {t(
                '服务包由本机准备，通过所选 SSH 连接上传，远端无需访问互联网。更新保留直连端口和配对身份，完成后仍使用 HTTPS / WSS 连接。'
              )}
            </p>
          </details>
          {ssh ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block min-w-0">
                  {t('SSH 授权连接')}
                  <select
                    data-modal-autofocus
                    disabled={busy}
                    value={ssh.id}
                    onChange={event => {
                      setSshId(event.target.value)
                      setSecret('')
                      invalidate()
                    }}
                    className={field}
                  >
                    {candidates.map(connection => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name} · {connection.username}@{connection.host}:{connection.port}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block min-w-0">
                  {t(ssh.auth_kind === 'password' ? 'SSH 密码' : 'SSH 私钥口令（可选）')}
                  <input
                    disabled={busy}
                    type="password"
                    value={secret}
                    onChange={event => {
                      setSecret(event.target.value)
                      invalidate()
                    }}
                    autoComplete="new-password"
                    placeholder={t('留空使用已保存或当前会话中的 SSH 凭据')}
                    className={field}
                  />
                </label>
              </div>
              <div className="space-y-2.5 rounded-lg border border-dialog-border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block min-w-0 flex-1 basis-64">
                    {t('服务包来源')}
                    <select
                      disabled={busy}
                      value={mode}
                      className={field}
                      onChange={event => {
                        setMode(event.target.value as typeof mode)
                        invalidate()
                      }}
                    >
                      <option value="automatic">{t('自动获取（默认）')}</option>
                      <option value="offline">{t('使用本机离线包')}</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={busy || (mode === 'offline' && !directory)}
                    onClick={() => { setStartedAt(Date.now()); void prepare() }}
                    className="rounded border border-dialog-border px-3 py-1.5 disabled:opacity-40"
                  >
                    {t('检查并准备服务包')}
                  </button>
                </div>
                <p className="text-ui-sm text-fg-muted">
                  {t(
                    mode === 'automatic'
                      ? '本机服务包校验通过后自动更新；缺包时可手动准备并下载，远端无需联网。'
                      : '仅使用所选本机目录中的服务包，校验通过后自动更新。本次更新不联网下载，仍需通过 SSH 连接远端。'
                  )}
                </p>
                {mode === 'offline' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 basis-64 select-text break-all text-ui-sm text-fg-muted">
                      {directory || t('未选择离线目录')}
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void chooseDirectory()}
                      className="rounded border border-dialog-border px-3 py-1.5 disabled:opacity-40"
                    >
                      {t('选择离线目录')}
                    </button>
                  </div>
                )}
                {info && (
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-ui-sm text-fg-muted sm:grid-cols-2">
                    <div className="min-w-0 break-words">
                      <dt className="inline">{t('客户端需要的版本')}：</dt>
                      <dd className="inline select-text text-fg">{info.expectedVersion}</dd>
                    </div>
                    <div className="min-w-0 break-words">
                      <dt className="inline">{t('服务包版本')}：</dt>
                      <dd className="inline select-text text-fg">
                        {info.packageVersion || t('未知')}
                      </dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="inline">{t('服务包来源')}：</dt>
                      <dd className="inline select-text break-all text-fg">
                        {info.sourcePath || t('未找到服务包')}
                      </dd>
                    </div>
                  </dl>
                )}
                {validPackage(info) && (
                  <p className="text-ui-sm text-ok">{t(working === 'update' ? '服务包已校验，正在更新。' : '服务包已校验，可开始更新。')}</p>
                )}
              </div>
            </>
          ) : (
            <p role="status">
              {t('未找到此主机的 SSH 连接。请先添加并确认 SSH 主机指纹，或在远端手动更新 Server。')}
            </p>
          )}
          {(error || info?.problem) && (
            <p role="alert" className="whitespace-pre-wrap break-words text-danger">
              {error || info?.problem}
            </p>
          )}
        </div>
        {busy && working !== 'choose' && (
          <div className="shrink-0 px-5 pb-3">
            <ServerOperationProgress
              compact
              name={direct?.name ?? ssh?.name ?? 'Server'}
              status={working === 'prepare' ? '准备中' : '更新中'}
              label={updatePhaseLabels[phase]}
              startedAt={startedAt}
              step={
                phase === 'connecting'
                  ? 1
                  : phase === 'checkingPackage' || phase === 'downloading'
                    ? 2
                    : phase === 'verifying'
                      ? 4
                      : 3
              }
            />
          </div>
        )}
        <footer className="flex shrink-0 justify-end gap-3 border-t border-dialog-separator bg-dialog-chrome px-5 py-3">
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="rounded border border-dialog-border px-3 py-1.5 disabled:opacity-40"
          >
            {t('取消')}
          </button>
          <button
            type="button"
            disabled={busy || !ssh || !validPackage(info)}
            onClick={() => { setStartedAt(Date.now()); void update() }}
            className="rounded bg-action px-3 py-1.5 text-on-action disabled:opacity-40"
          >
            {t(working === 'update' ? '正在更新…' : '更新并重新连接')}
          </button>
        </footer>
      </section>
    </ModalOverlay>
  )
}
