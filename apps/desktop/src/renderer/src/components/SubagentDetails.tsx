import { readSubagentThread, type CodexRpcLike, type ItemView } from '@qn/codex-client'
import { ChevronRight, GitFork } from 'lucide-react'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { friendlyError } from '../lib/errors'
import { Badge, ErrorNote, Modal, Spinner } from './ui'

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
        <p className="min-w-0 break-words text-ui-md text-qn-muted">{history?.name || '子会话记录'}</p>
        <button type="button" className="qn-button shrink-0" disabled={loading} onClick={() => {
          setLoading(true)
          setError(undefined)
          setVersion((current) => current + 1)
        }}>刷新记录</button>
      </div>
      {loading && <Spinner label="正在读取子代理记录…" />}
      {error && <ErrorNote message={error} />}
      {history && !history.view?.items.length && <p className="py-3 text-ui-md text-qn-muted">暂无子会话记录。</p>}
      {history?.view?.error && <ErrorNote message={history.view.error} />}
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
    <div>
      <button type="button" className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg text-left text-ui text-qn-muted hover:bg-qn-hover hover:text-qn-text" aria-haspopup="dialog"
        onClick={() => setSelected(agents[0]?.threadId ?? '')}>
        <GitFork size={15} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{item.title}{agents.length > 1 ? ` · ${agents.length}` : ''}</span>
        {item.status && <Badge>{item.status}</Badge>}
        <ChevronRight size={15} className="shrink-0 text-qn-dim" aria-hidden />
      </button>
      {selected !== null && (
        <Modal title={item.title} width="max-w-3xl" onClose={() => setSelected(null)}>
          {item.detail && <p className="mb-3 whitespace-pre-wrap break-words text-ui-md text-qn-muted">{item.detail}</p>}
          {agents.length > 1 && <div className="mb-3 flex flex-wrap gap-2" aria-label="子代理">
            {agents.map((candidate, index) => <button type="button" key={candidate.threadId} aria-pressed={agent === candidate}
              className={`qn-button ${agent === candidate ? 'text-qn-accent' : ''}`} onClick={() => setSelected(candidate.threadId)}>
              {candidate.label || `子代理 ${index + 1}`}
            </button>)}
          </div>}
          {agent && <div className="mb-2 flex flex-wrap items-center gap-2 text-ui-sm text-qn-muted">
            <span className="break-all">{agent.label || agent.threadId}</span>{agent.status && <Badge>{agent.status}</Badge>}
          </div>}
          {result && <section className="mb-4 space-y-1">
            <h3 className="text-ui-md font-medium">子代理返回结果</h3>
            <div className="whitespace-pre-wrap break-words text-ui-md">{result}</div>
          </section>}
          {agent && rpc && <History key={agent.threadId} threadId={agent.threadId} rpc={rpc} renderItem={renderItem} />}
          {agent && !rpc && <p className="text-ui-md text-qn-muted">会话连接暂不可用。</p>}
          {!agent && !item.detail && !result && <p className="text-ui-md text-qn-muted">暂无子代理详情。</p>}
        </Modal>
      )}
    </div>
  )
}
