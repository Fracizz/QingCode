import { useEffect, useState } from 'react'
import { CodexRpcError, listMcpStatus, mcpStatusLabel, t, type AgentKind, type CodexRpcLike, type McpServerView } from '@qn/codex-client'
import { LoadingIcon } from './LoadingIcon'
import { Modal } from './ui'

export function McpStatusDialog({ agent, threadId, rpc, onClose }: {
  agent: AgentKind
  threadId: string
  rpc: CodexRpcLike
  onClose: () => void
}) {
  const [servers, setServers] = useState<McpServerView[] | null>()
  const [error, setError] = useState('')
  useEffect(() => {
    let watching = true
    void listMcpStatus(rpc, agent, threadId).then(
      (result) => { if (watching) setServers(result) },
      (reason) => {
        if (watching) setError(reason instanceof CodexRpcError && reason.code === -32601
          ? t('当前目标不支持读取 MCP 服务状态') : t('无法读取 MCP 服务状态'))
      },
    )
    return () => { watching = false }
  }, [rpc, agent, threadId])

  return (
    <Modal title={t('MCP 服务状态')} onClose={onClose}>
      {error ? <p role="alert" className="text-ui text-qn-danger">{error}</p> : servers === undefined ? (
        <p role="status" className="flex items-center gap-2 text-ui text-qn-muted"><LoadingIcon />{t('正在读取 MCP 服务状态…')}</p>
      ) : !servers?.length ? (
        <p className="text-ui text-qn-muted">{servers ? t('当前会话没有 MCP 服务') : t('请先在此会话中发送一条消息')}</p>
      ) : (
        <ul className="divide-y divide-qn-border">
          {servers.map(({ name, status, toolCount, environmentId }) => (
            <li key={JSON.stringify([name, environmentId])} className="flex items-center justify-between gap-3 py-2 text-ui">
              <span className="min-w-0 break-words">{name}</span>
              <span className="shrink-0 text-qn-muted">{mcpStatusLabel(status)}{toolCount === undefined ? '' : ` · ${t('工具数 {count}', { count: toolCount })}`}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
