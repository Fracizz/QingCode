import { useEffect, useRef, useState } from 'react'
import { directAgentErrorKey, type DirectAgentApi, type DirectAgentInfo } from '../lib/directAgent'
import { hydrateSshSecrets, sshRuntimeConfig, sshSecretsFor } from '../lib/sshWorkspace'
import type { SshConnection } from '../types'

/** error / notice 为 i18n 键，由调用方翻译；warning 是远端返回的原始原因。 */
export interface DirectServerManageOutcome {
  error?: string
  notice?: string
  warning?: string
}

interface Options {
  connectionId: string
  info: DirectAgentInfo | null
  ssh: SshConnection | undefined
  password: string
  passphrase: string
  autoStart: boolean
  api: DirectAgentApi
  onManaged?: (info: DirectAgentInfo) => void | Promise<void>
  onStarted?: () => void | Promise<void>
  onBusyChange?: (busy: boolean) => void
}

/** 通过 SSH 启动已配对的 Server 或应用开机自启；过期请求返回 null，调用方不得更新界面。 */
export function useDirectServerManage({ connectionId, info, ssh, password, passphrase, autoStart, api, onManaged, onStarted, onBusyChange }: Options) {
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const host = info?.host
  const port = info?.port
  useEffect(() => () => { request.current += 1 }, [connectionId, host, port])

  const manage = async (start: boolean): Promise<DirectServerManageOutcome | null> => {
    if (!ssh || !info || busy || !api.manage) return null
    const current = ++request.current
    setBusy(true)
    onBusyChange?.(true)
    try {
      await hydrateSshSecrets(ssh.id)
      if (current !== request.current) return null
      const result = await api.manage({
        connectionId, sshConnectionId: ssh.id, agentHost: info.host, port: info.port, autoStart, start,
        config: sshRuntimeConfig(ssh, { ...sshSecretsFor(ssh.id), ...(password ? { password } : {}), ...(passphrase ? { passphrase } : {}) }),
      })
      if (current !== request.current) return null
      await onManaged?.(result)
      if (current !== request.current) return null
      if (start) await onStarted?.()
      if (current !== request.current) return null
      const warning = result.startupWarning || undefined
      return { warning, notice: start ? 'Server 已启动，正在重新连接…' : warning ? undefined : '开机自启设置已应用。' }
    } catch (reason) {
      return current === request.current ? { error: directAgentErrorKey(reason) } : null
    } finally {
      if (current === request.current) { setBusy(false); onBusyChange?.(false) }
    }
  }

  return { busy, manage }
}
