import {
  t,
  collectSubagents, mergeSubagentHistory, prependThreadHistory, readSubagentThread, readThreadHistoryPage,
  subagentAvatar, subagentRecordStatus, subagentStatusTone,
  type CodexRpcLike, type ItemView, type SubagentEntry, type ThreadView,
} from '@qn/codex-client'
import { Atom, Bot, ChevronRight, X, Compass, Feather, Gem, Leaf, Puzzle, Rocket, Telescope, type LucideIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { friendlyError } from '../lib/errors'
import { streamingReplyId } from '../lib/turnGroups'
import { RefreshIcon } from './LoadingIcon'
import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger } from './primitives'
import { StatusDot } from './StatusDot'
import { Badge, EmptyState, ErrorNote, IconButton, Modal, Spinner } from './ui'

export const SubagentRpcContext = createContext<CodexRpcLike | null>(null)

type RenderItem = (item: ItemView, showStreamingDots: boolean) => ReactNode
type History = Awaited<ReturnType<typeof readSubagentThread>>
const NO_ITEMS: readonly ItemView[] = []
const HISTORY_BATCH = 40

function AgentBadge({ status }: { status: string }) {
  const tone = subagentStatusTone(status)
  return <Badge tone={tone === 'active' ? 'accent' : tone}>{status || t('状态未知')}</Badge>
}

// 子代理头像：按子代理标识稳定取图标和配色，多个子代理一眼可分；不传标识时用通用机器人图标。
// 实色底 + 白色图标，与项目首字母头像同一套 avatar token，深浅主题下图标对比度都足够。
const agentSeed = (entry: SubagentEntry) => entry.threadId || entry.key
const AVATAR_ICONS = [Telescope, Compass, Rocket, Feather, Leaf, Atom, Puzzle, Gem] satisfies LucideIcon[]
const AVATAR_COLORS = [
  'bg-qn-avatar-1', 'bg-qn-avatar-2', 'bg-qn-avatar-3', 'bg-qn-avatar-4',
  'bg-qn-avatar-5', 'bg-qn-avatar-6', 'bg-qn-avatar-7', 'bg-qn-avatar-8',
]

function AgentAvatar({ seed, size = 17, className = 'size-8' }: { seed?: string; size?: number; className?: string }) {
  if (!seed) return <span className={`grid shrink-0 place-items-center rounded-lg bg-violet-400/12 text-violet-300 ${className}`}>
    <Bot size={size} strokeWidth={1.8} aria-hidden />
  </span>
  const { icon, color } = subagentAvatar(seed)
  const Icon = AVATAR_ICONS[icon % AVATAR_ICONS.length]!
  return <span className={`grid shrink-0 place-items-center rounded-lg text-white ${AVATAR_COLORS[color % AVATAR_COLORS.length]} ${className}`}>
    <Icon size={size} strokeWidth={1.9} aria-hidden />
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
        <AgentAvatar seed={agentSeed(entry)} size={19} />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-ui-md font-semibold">{name}</h3>
          {metadata && <p className="mt-0.5 break-words text-ui-sm text-qn-muted">{metadata}</p>}
        </div>
        <AgentBadge status={subagentRecordStatus(entry.status, history?.data.view)} />
      </div>
      {task && <section className="space-y-1">
        <h4 className="text-ui-sm font-medium text-qn-muted">{t('委派任务')}</h4>
        <p className="whitespace-pre-wrap break-words rounded-lg border border-qn-border bg-qn-bg/60 px-3 py-2 text-ui">{task}</p>
      </section>}
      {entry.result && <section className="space-y-1">
        <h4 className="text-ui-sm font-medium text-qn-muted">{t('返回结果')}</h4>
        <div className="whitespace-pre-wrap break-words rounded-lg border border-qn-border bg-qn-bg/60 px-3 py-2 text-ui">{entry.result}</div>
      </section>}
      {entry.activity.length > 0 && (
        <details className="rounded-lg border border-qn-border px-3 py-2 text-ui">
          <summary className="cursor-pointer select-none font-medium text-qn-muted">{t('活动记录 · {count}', { count: entry.activity.length })}</summary>
          <ol className="mt-2 divide-y divide-qn-border">
            {entry.activity.map((event) => (
              <li key={event.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <span>{event.title}</span>
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
          <h4 className="text-ui-sm font-medium text-qn-muted">{items.length ? t('子会话记录 · {count} 条', { count: items.length }) : t('子会话记录')}</h4>
          <IconButton label={t('刷新记录')} size="sm" disabled={!rpc || reading} onClick={refreshHistory}>
            <RefreshIcon loading={reading} />
          </IconButton>
        </div>
        {reading && <Spinner label={t('正在读取子代理记录…')} />}
        {error && <ErrorNote message={error} />}
        {turnError && <ErrorNote message={turnError} />}
        {!rpc && <p className="text-ui-sm text-qn-muted">{t('会话连接暂不可用。')}</p>}
        {!items.length && !reading && !error && rpc && <p className="text-ui-sm text-qn-muted">{t('暂无子会话记录。')}</p>}
        {(items.length > limit || rpc && view?.historyCursor) && (
          <button type="button" className="qn-button" disabled={reading || loadingEarlier} onClick={() => void showEarlier()}>
            {loadingEarlier ? t('正在加载更早记录…') : t('查看更早记录')}
          </button>
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
  const titleId = useId()
  const [selected, setSelected] = useState('')
  const entry = entries.find((item) => item.key === selected) ?? entries[0]
  const active = entries.filter(({ status }) => ['active', 'warn'].includes(subagentStatusTone(status))).length
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <IconButton label={t('子代理')} tooltipSide="bottom"
          className={entries.length ? 'w-auto gap-1.5 px-2 text-violet-300' : undefined}>
          <Bot size={17} strokeWidth={1.8} aria-hidden />
          {entries.length > 0 && <span className="text-ui-sm tabular-nums" aria-hidden>{entries.length}</span>}
          {active > 0 && <StatusDot className="bg-qn-accent" />}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" aria-labelledby={titleId}
        className="flex max-h-[min(72vh,var(--radix-popover-content-available-height))] w-[min(700px,calc(100vw-24px))] flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-qn-border px-3 py-2.5">
          <AgentAvatar />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-ui-md font-semibold">{t('子代理')}</h2>
            <p className="text-ui-sm text-qn-muted">{t('{count} 个子代理', { count: entries.length })}
              {active > 0 ? ` · ${t('{count} 个活动中', { count: active })}` : ''}
            </p>
          </div>
          <PopoverClose asChild><IconButton label={t('关闭')} tooltip={false}><X size={16} /></IconButton></PopoverClose>
        </div>
        {entry ? (
          <div className="grid min-h-0 grid-cols-[minmax(160px,32%)_minmax(0,1fr)]">
            <div className="qn-scroll space-y-1 overflow-y-auto overscroll-contain border-r border-qn-border p-2" aria-label={t('子代理列表')}>
              {entries.map((item) => (
                <button type="button" key={item.key} aria-pressed={item === entry} onClick={() => setSelected(item.key)}
                  className="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-qn-hover focus-visible:outline-qn-outline-hover aria-pressed:bg-qn-active">
                  <AgentAvatar seed={agentSeed(item)} size={15} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium" title={item.name}>{item.name}</span>
                    <span className="mt-0.5 block truncate text-ui-sm text-qn-muted">{item.status || t('状态未知')}</span>
                  </span>
                  <ChevronRight size={13} className="shrink-0 text-qn-dim" aria-hidden />
                </button>
              ))}
            </div>
            <div className="qn-scroll min-h-0 overflow-y-auto overscroll-contain p-4" key={entry.key}>
              <SubagentRpcContext.Provider value={rpc}>
                <AgentRecord entry={entry} live={entry.threadId ? threads?.[entry.threadId] : undefined} rpc={rpc} renderItem={renderItem} />
              </SubagentRpcContext.Provider>
            </div>
          </div>
        ) : <EmptyState>{t('当前会话暂无子代理。')}</EmptyState>}
      </PopoverContent>
    </PopoverRoot>
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
    <div>
      <button type="button" className="qn-message-activity flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg text-left text-ui text-qn-muted hover:bg-qn-hover hover:text-qn-text" aria-haspopup="dialog"
        onClick={() => setSelected(entries[0]?.key ?? '')}>
        {entries.length === 1
          ? <AgentAvatar seed={agentSeed(entries[0]!)} size={12} className="size-5 rounded-md" />
          : <Bot size={16} strokeWidth={1.8} className="shrink-0 text-violet-300" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{item.title}{entries.length > 1 ? ` · ${entries.length}` : ''}</span>
        {item.status && <AgentBadge status={item.status} />}
        <ChevronRight size={15} className="shrink-0 text-qn-dim" aria-hidden />
      </button>
      {selected !== null && (
        <Modal title={item.title} width="max-w-3xl" onClose={() => setSelected(null)}>
          {entries.length > 1 && <div className="mb-3 flex flex-wrap gap-2" aria-label={t('子代理列表')}>
            {entries.map((candidate) => <button type="button" key={candidate.key} aria-pressed={candidate === entry}
              className={`qn-button ${candidate === entry ? 'text-qn-accent' : ''}`} onClick={() => setSelected(candidate.key)}>
              {candidate.name}
            </button>)}
          </div>}
          {entry
            ? <AgentRecord key={entry.key} entry={entry} rpc={rpc} renderItem={renderItem} />
            : <p className="whitespace-pre-wrap break-words text-ui-md text-qn-muted">{item.detail || t('暂无子代理详情。')}</p>}
        </Modal>
      )}
    </div>
  )
}
