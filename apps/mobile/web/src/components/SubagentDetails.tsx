import {
  collectSubagents, mergeSubagentHistory, prependThreadHistory, readSubagentThread, readThreadHistoryPage,
  subagentRecordStatus, subagentStatusTone,
  type CodexRpcLike, type ItemView, type SubagentEntry, type ThreadView,
  t,
  translateMessage,
} from '@qn/codex-client'
import { ArrowLeft, Bot, ChevronRight, RotateCw } from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { streamingReplyId } from '../chatGroups'
import { friendlyError } from '../state'
import { Badge, Button, Dialog, Empty, Loading, Note } from './ui'

export const SubagentRpcContext = createContext<CodexRpcLike | null>(null)

type RenderItem = (item: ItemView, showStreamingDots: boolean) => ReactNode
type History = Awaited<ReturnType<typeof readSubagentThread>>
const NO_ITEMS: readonly ItemView[] = []
const HISTORY_BATCH = 40

function AgentBadge({ status }: { status: string }) {
  const tone = subagentStatusTone(status)
  return <Badge tone={tone === 'active' ? 'accent' : tone}>{status ? translateMessage(status) : t('状态未知')}</Badge>
}

function AgentAvatar({ size = 17 }: { size?: number }) {
  return <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet-400/12 text-violet-300">
    <Bot size={size} strokeWidth={1.8} aria-hidden />
  </span>
}

function AgentRecord({ entry, live, rpc, renderItem }: {
  entry: SubagentEntry
  live?: ThreadView
  rpc: CodexRpcLike | null
  renderItem: RenderItem
}) {
  const [request, setRequest] = useState(0)
  const [history, setHistory] = useState<{ data: History; beforeRead: readonly ItemView[] }>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(Boolean(entry.threadId && rpc))
  const reading = Boolean(rpc && loading)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const earlierRequest = useRef<symbol | undefined>(undefined)
  const [limit, setLimit] = useState(HISTORY_BATCH)
  const latestItems = useRef(live?.items ?? NO_ITEMS)
  latestItems.current = live?.items ?? NO_ITEMS
  const threadId = entry.threadId

  useEffect(() => {
    setLimit(HISTORY_BATCH)
    setLoadingEarlier(false)
    if (!rpc || !threadId) return
    let current = true
    const beforeRead = latestItems.current
    setError(undefined)
    setLoading(true)
    void readSubagentThread(rpc, threadId, () => current).then((data) => {
      if (current) setHistory({ data, beforeRead })
    }, (err: unknown) => {
      if (current) setError(friendlyError(err, t('无法读取子代理记录')))
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => {
      current = false
      earlierRequest.current = undefined
    }
  }, [rpc, threadId, request])

  const view = history?.data.view
  const items = useMemo(() => mergeSubagentHistory(
    history?.data.view?.items ?? NO_ITEMS, live?.items ?? NO_ITEMS, history?.beforeRead ?? NO_ITEMS,
  ), [history, live?.items])
  const streamingId = streamingReplyId(live ?? history?.data.view ?? undefined)
  const name = history?.data.name || entry.name
  const role = history?.data.role || entry.role
  const model = history?.data.model || entry.model
  const metadata = [role !== name && role, model].filter(Boolean).join(' · ')
  const task = entry.task || history?.data.task
  const liveHasOutcome = live?.activity === 'completed' || live?.activity === 'interrupted'
  const turnError = live && (live.status !== 'idle' || liveHasOutcome) ? live.error : history?.data.view?.error

  function refreshHistory() {
    earlierRequest.current = undefined
    setRequest((value) => value + 1)
  }

  async function showEarlier() {
    if (items.length > limit) {
      setLimit((value) => value + HISTORY_BATCH)
      return
    }
    if (!rpc || !threadId || !view?.historyCursor || earlierRequest.current) return
    const token = Symbol()
    earlierRequest.current = token
    const isCurrent = () => earlierRequest.current === token
    setLoadingEarlier(true)
    setError(undefined)
    try {
      const page = await readThreadHistoryPage(rpc, threadId, view.historyCursor, isCurrent)
      if (!isCurrent()) return
      const next = prependThreadHistory({ threads: { [threadId]: view } }, threadId, page).threads[threadId]
      setHistory((value) => value?.data.view === view ? { ...value, data: { ...value.data, view: next } } : value)
      setLimit(items.length + HISTORY_BATCH)
    } catch (err) {
      if (isCurrent()) setError(friendlyError(err, t('无法读取更早的子代理记录')))
    } finally {
      if (isCurrent()) {
        earlierRequest.current = undefined
        setLoadingEarlier(false)
      }
    }
  }

  return (
    <section className="space-y-4" aria-label={t('子代理详情')}>
      <div className="flex items-start gap-2.5">
        <AgentAvatar size={19} />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-semibold">{name}</h3>
          {metadata && <p className="mt-0.5 break-words text-xs text-qn-muted">{metadata}</p>}
        </div>
        <AgentBadge status={subagentRecordStatus(entry.status, history?.data.view)} />
      </div>
      {task && <section className="space-y-1">
        <h4 className="text-xs font-medium text-qn-muted">{t('委派任务')}</h4>
        <p className="whitespace-pre-wrap break-words rounded-lg border border-qn-border bg-qn-bg/60 px-3 py-2 text-[13px]">{task}</p>
      </section>}
      {entry.result && <section className="space-y-1">
        <h4 className="text-xs font-medium text-qn-muted">{t('返回结果')}</h4>
        <div className="whitespace-pre-wrap break-words rounded-lg border border-qn-border bg-qn-bg/60 px-3 py-2 text-[13px]">{entry.result}</div>
      </section>}
      {entry.activity.length > 0 && (
        <details className="rounded-lg border border-qn-border px-3 py-2 text-[13px]">
          <summary className="cursor-pointer select-none font-medium text-qn-muted">{t('活动记录 · {count}', { count: entry.activity.length })}</summary>
          <ol className="mt-2 divide-y divide-qn-border">
            {entry.activity.map((event) => (
              <li key={event.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <span>{translateMessage(event.title)}</span>
                  {event.status && <AgentBadge status={event.status} />}
                </div>
                {event.detail && event.detail !== task && <p className="mt-1 whitespace-pre-wrap break-words text-qn-muted">{event.detail}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {threadId && <section className="space-y-2 border-t border-qn-border pt-3" aria-label={t('子会话记录')}>
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-medium text-qn-muted">{items.length ? t('子会话记录 · {count} 条', { count: items.length }) : t('子会话记录')}</h4>
          <Button variant="ghost" aria-label={t('刷新记录')} disabled={!rpc || reading} onClick={refreshHistory}>
            <RotateCw size={16} aria-hidden />
          </Button>
        </div>
        {reading && <Loading text={t('正在读取子代理记录…')} />}
        {error && <Note tone="error" message={error} />}
        {turnError && <Note tone="error" message={turnError} />}
        {!rpc && <p className="text-xs text-qn-muted">{t('会话连接暂不可用。')}</p>}
        {!items.length && !reading && !error && rpc && <p className="text-xs text-qn-muted">{t('暂无子会话记录。')}</p>}
        {(items.length > limit || rpc && view?.historyCursor) && (
          <Button variant="ghost" disabled={reading || loadingEarlier} onClick={() => void showEarlier()}>
            {loadingEarlier ? t('正在加载更早记录…') : t('查看更早记录')}
          </Button>
        )}
        <div className="space-y-3">{items.slice(-limit).map((item) => renderItem(item, item.id === streamingId))}</div>
      </section>}
    </section>
  )
}

export function SubagentLauncher({ entries, threads, rpc, renderItem }: {
  entries: readonly SubagentEntry[]
  threads?: Readonly<Record<string, ThreadView>>
  rpc: CodexRpcLike | null
  renderItem: RenderItem
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const entry = entries.find((item) => item.key === selected)
  const active = entries.filter(({ status }) => ['active', 'warn'].includes(subagentStatusTone(status))).length

  return (
    <>
      <Button variant="ghost" className="qn-header-icon shrink-0" aria-label={t('子代理')} aria-haspopup="dialog"
        aria-expanded={open} onClick={() => { setSelected(''); setOpen(true) }}>
        <span className={`relative ${entries.length ? 'text-violet-300' : ''}`}>
          <Bot size={20} strokeWidth={1.8} aria-hidden />
          {entries.length > 0 && <span aria-hidden className={`absolute -right-2 -top-1 min-w-3.5 rounded-full px-0.5 text-[9px] leading-3.5 tabular-nums ${active ? 'bg-qn-accent text-qn-bg' : 'bg-qn-active text-qn-text'}`}>
            {entries.length > 99 ? '99+' : entries.length}
          </span>}
        </span>
      </Button>
      {open && (
        <Dialog title={t('子代理')} placement="full" onClose={() => setOpen(false)}>
          <div className="qn-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" key={entry?.key ?? 'list'}>
            {entry ? (
              <SubagentRpcContext.Provider value={rpc}>
                <Button variant="ghost" className="mb-3 gap-1" onClick={() => setSelected('')}>
                  <ArrowLeft size={16} aria-hidden /> {t('返回子代理列表')}
                </Button>
                <AgentRecord entry={entry} live={entry.threadId ? threads?.[entry.threadId] : undefined} rpc={rpc} renderItem={renderItem} />
              </SubagentRpcContext.Provider>
            ) : entries.length > 0 ? (
              <>
                <p className="mb-3 text-sm text-qn-muted">{entries.length === 1 ? t('1 个子代理') : t('{count} 个子代理', { count: entries.length })}{active > 0 ? ` · ${t('{count} 个活动中', { count: active })}` : ''}</p>
                <div className="space-y-1.5" aria-label={t('子代理列表')}>
                  {entries.map((item) => (
                    <button type="button" key={item.key} onClick={() => setSelected(item.key)}
                      className="flex min-h-14 w-full items-center gap-2.5 rounded-xl border border-qn-border px-2.5 py-2 text-left active:bg-qn-hover">
                      <AgentAvatar />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.name}</span>
                        {item.task && <span className="mt-0.5 block truncate text-xs text-qn-muted">{item.task}</span>}
                      </span>
                      <AgentBadge status={item.status} />
                      <ChevronRight size={15} className="shrink-0 text-qn-muted" aria-hidden />
                    </button>
                  ))}
                </div>
              </>
            ) : <Empty>{t('当前会话暂无子代理。')}</Empty>}
          </div>
        </Dialog>
      )}
    </>
  )
}

export function SubagentDetails({ item, renderItem }: {
  item: Extract<ItemView, { kind: 'subagent' }>
  renderItem: RenderItem
}) {
  const rpc = useContext(SubagentRpcContext)
  const [selected, setSelected] = useState<string | null>(null)
  const entries = collectSubagents([item])
  const entry = entries.find((candidate) => candidate.key === selected) ?? entries[0]
  return (
    <div className="qn-tool">
      <button type="button" className="qn-tool-row w-full cursor-pointer text-left" aria-haspopup="dialog"
        onClick={() => setSelected(entries[0]?.key ?? '')}>
        <Bot size={16} strokeWidth={1.8} className="shrink-0 text-violet-300" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{translateMessage(item.title)}{entries.length > 1 ? ` · ${entries.length}` : ''}</span>
        {item.status && <AgentBadge status={item.status} />}
        <ChevronRight size={15} className="shrink-0 text-qn-dim" aria-hidden />
      </button>
      {selected !== null && (
        <Dialog title={translateMessage(item.title)} placement="full" onClose={() => setSelected(null)}>
          {entries.length > 1 && <div className="mb-3 flex flex-wrap gap-2" aria-label={t('子代理列表')}>
            {entries.map((candidate) => <Button key={candidate.key} aria-pressed={candidate === entry}
              variant={candidate === entry ? 'primary' : 'ghost'} onClick={() => setSelected(candidate.key)}>
              {candidate.name}
            </Button>)}
          </div>}
          {entry
            ? <AgentRecord key={entry.key} entry={entry} rpc={rpc} renderItem={renderItem} />
            : <p className="whitespace-pre-wrap break-words text-sm text-qn-muted">{item.detail || t('暂无子代理详情。')}</p>}
        </Dialog>
      )}
    </div>
  )
}
