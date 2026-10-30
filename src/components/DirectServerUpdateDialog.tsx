import { useId, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import { safeInvoke } from '../lib/tauri'
import { directAgentSshCandidates } from '../lib/directAgent'
import { sshConnectionIdFromUri, sshRuntimeConfig, sshSecretsFor } from '../lib/sshWorkspace'
import { parseSshServerState } from '../lib/sshServerStatus'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import ModalOverlay from './ModalOverlay'

const field = 'mt-1 w-full rounded border border-dialog-border bg-dialog-input px-3 py-2 text-fg'

export default function DirectServerUpdateDialog({ rootUri }: { rootUri: string }) {
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ssh =
    candidates.find(connection => connection.id === sshId) ??
    candidates.find(connection => connection.id === connectionId) ??
    candidates[0]
  const close = () => {
    if (!busy) useUIStore.setState({ serverUpdateRootUri: null })
  }
  const update = async () => {
    if (busy || !ssh) return
    setBusy(true)
    setError('')
    try {
      const value = await safeInvoke<unknown>('更新远端服务', 'direct_agent_update', {
        rootUri,
        sshConnectionId: ssh.id,
        config: sshRuntimeConfig(ssh, {
          ...sshSecretsFor(ssh.id),
          ...(secret
            ? ssh.auth_kind === 'password'
              ? { password: secret }
              : { passphrase: secret }
            : {}),
        }),
      })
      const state = parseSshServerState(value)
      if (state?.phase !== 'readyServer' || state.transport !== 'agent')
        throw new Error(state?.reason ?? t('远端服务尚未就绪'))
      pushToast('success', t('已更新远端服务，请重新新建终端或重试原操作'))
      useUIStore.setState({ serverUpdateRootUri: null })
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
      setSecret('')
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
        className="w-full max-w-xl overflow-hidden rounded-lg border border-dialog-border bg-dialog text-ui text-fg shadow-elevation-3"
      >
        <h2 id={`${id}-title`} className="bg-dialog-chrome px-5 py-4 text-ui-lg font-semibold">
          {t('通过 SSH 更新远端服务')}
        </h2>
        <div className="space-y-4 p-5">
          <p id={`${id}-impact`} className="text-warn">
            {t(
              '将安装与当前客户端匹配的远端服务并替换旧版本。更新会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。'
            )}
          </p>
          <p className="text-fg-muted">
            {t(
              '更新通过所选 SSH 连接上传服务包，保留直连端口和配对身份。完成后仍使用 HTTPS / WSS 连接。'
            )}
          </p>
          <p className="break-all">
            {direct?.name} · {direct?.agentEndpoint?.host ?? direct?.host}
          </p>
          {ssh ? (
            <>
              <label className="block">
                {t('SSH 授权连接')}
                <select
                  data-modal-autofocus
                  disabled={busy}
                  value={ssh.id}
                  onChange={event => {
                    setSshId(event.target.value)
                    setSecret('')
                    setError('')
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
              <label className="block">
                {t(ssh.auth_kind === 'password' ? 'SSH 密码' : 'SSH 私钥口令（可选）')}
                <input
                  disabled={busy}
                  type="password"
                  value={secret}
                  onChange={event => setSecret(event.target.value)}
                  autoComplete="new-password"
                  placeholder={t('留空使用当前会话中已有的 SSH 凭据')}
                  className={field}
                />
              </label>
            </>
          ) : (
            <p role="status">
              {t('未找到此主机的 SSH 连接。请先添加并确认 SSH 主机指纹，或在远端手动更新 Server。')}
            </p>
          )}
          {error && (
            <p role="alert" className="whitespace-pre-wrap break-words text-danger">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" className="flex items-center gap-2">
              <LoaderCircle size={16} className="animate-spin" aria-hidden />
              {t('正在上传、更新并验证远端服务…')}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-3 border-t border-dialog-separator bg-dialog-chrome px-5 py-3">
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
            disabled={busy || !ssh}
            onClick={() => void update()}
            className="rounded bg-action px-3 py-1.5 text-on-action disabled:opacity-40"
          >
            {t(busy ? '正在更新…' : '更新并重新连接')}
          </button>
        </footer>
      </section>
    </ModalOverlay>
  )
}
