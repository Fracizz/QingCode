import { useEffect, useState } from 'react'
import { directAgentApi } from '../lib/directAgent'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'

/** Show the active transport's endpoint, never the SSH placeholder for an Agent. */
export default function ConnectionEndpointDetails({ connectionId, agent }: { connectionId: string; agent: boolean }) {
  const { t } = useI18n()
  const connection = useProjectStore(state => state.sshConnections.find(item => item.id === connectionId))
  const [endpoint, setEndpoint] = useState<{ host: string; port: number } | null>(null)

  useEffect(() => {
    if (!agent) return
    let cancelled = false
    void directAgentApi.info(connectionId).then(info => {
      if (!cancelled) setEndpoint(info?.enabled ? { host: info.host, port: info.port } : null)
    }).catch(() => {
      if (!cancelled) setEndpoint(null)
    })
    return () => { cancelled = true }
  }, [connectionId, agent])

  const target = agent ? endpoint : connection
  return <>
    <div className="min-w-0">
      <dt className="mb-1 text-ui-sm text-dialog-label">{t(agent ? 'Server 主机' : '主机')}</dt>
      <dd className="break-words font-mono text-ui-sm [overflow-wrap:anywhere]">{target?.host || t('未知')}</dd>
    </div>
    <div className="min-w-0">
      <dt className="mb-1 text-ui-sm text-dialog-label">{t('TCP 端口')}</dt>
      <dd className="font-mono text-ui-sm">{target?.port ?? t('未知')}</dd>
    </div>
  </>
}
