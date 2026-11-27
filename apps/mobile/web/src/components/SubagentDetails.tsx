import { readSubagentThread, type CodexRpcLike, type ItemView } from '@qn/codex-client'
import { ChevronRight, GitFork } from 'lucide-react'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { friendlyError } from '../state'
import { Badge, Button, Dialog, Loading, Note } from './ui'

export const SubagentRpcContext = createContext<CodexRpcLike | null>(null)

type RenderItem = (item: ItemView) => ReactNode

function History({ rpc, threadId, renderItem }: { rpc: CodexRpcLike; threadId: string; renderItem: RenderItem }) {
  const [version, setVersion] = useState(0)
  const [history, setHistory] = useState<Awaited<ReturnType<typeof readSubagentThread>>>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    void readSubagentThread(rpc, threadId).then((result) => {
      if (active) setHistory(result)
    }, (err: unknown) => {
      if (active) setError(friendlyError(err, '无法读取子代理记录'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [rpc, threadId, version])

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 break-words text-sm text-qn-muted">{history?.name || '子会话记录'}</p>
        <Button variant="ghost" disabled={loading} onClick={() => {
          setLoading(true)
          setError(undefined)
          setVersion((current) => current + 1)
        }}>刷新记录</Button>
      </div>
      {loading && <Loading text="正在读取子代理记录…" />}
      {error && <Note tone="error" message={error} />}
      {history && !history.view?.items.length && <p className="py-3 text-sm text-qn-muted">暂无子会话记录。</p>}
      {history?.view?.error && <Note tone="error" message={history.view.error} />}
      <div className="space-y-3">{history?.view?.items.map(renderItem)}</div>
    </>
  )
}

export function SubagentDetails({ item, renderItem }: {
  item: Extract<ItemView, { kind: 'subagent' }>
  renderItem: RenderItem
}) {
  const rpc = useContext(SubagentRpcContext)
  const [selected, setSelected] = useState<string | null>(null)
  const agents = item.agents ?? []
  const agent = agents.find((candidate) => candidate.threadId === selected) ?? agents[0]
  const result = agent?.result || item.result
  return (
    <div className="qn-tool">
      <button type="button" className="qn-tool-row w-full cursor-pointer text-left" aria-haspopup="dialog"
        onClick={() => setSelected(agents[0]?.threadId ?? '')}>
        <GitFork size={15} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{item.title}{agents.length > 1 ? ` · ${agents.length}` : ''}</span>
        {item.status && <Badge>{item.status}</Badge>}
        <ChevronRight size={15} className="shrink-0 text-qn-dim" aria-hidden />
      </button>
      {selected !== null && (
        <Dialog title={item.title} placement="full" onClose={() => setSelected(null)}>
          {item.detail && <p className="mb-3 whitespace-pre-wrap break-words text-sm text-qn-muted">{item.detail}</p>}
          {agents.length > 1 && <div className="mb-3 flex flex-wrap gap-2" aria-label="子代理">
            {agents.map((candidate, index) => <Button key={candidate.threadId} aria-pressed={agent === candidate}
              variant={agent === candidate ? 'primary' : 'ghost'} onClick={() => setSelected(candidate.threadId)}>
              {candidate.label || `子代理 ${index + 1}`}
            </Button>)}
          </div>}
          {agent && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-qn-muted">
            <span className="break-all">{agent.label || agent.threadId}</span>{agent.status && <Badge>{agent.status}</Badge>}
          </div>}
          {result && <section className="mb-4 space-y-1">
            <h3 className="text-sm font-medium">子代理返回结果</h3>
            <div className="whitespace-pre-wrap break-words text-sm">{result}</div>
          </section>}
          {agent && rpc && <History key={agent.threadId} threadId={agent.threadId} rpc={rpc} renderItem={renderItem} />}
          {agent && !rpc && <p className="text-sm text-qn-muted">会话连接暂不可用。</p>}
          {!agent && !item.detail && !result && <p className="text-sm text-qn-muted">暂无子代理详情。</p>}
        </Dialog>
      )}
    </div>
  )
}
