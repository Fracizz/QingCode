import { Children, isValidElement, memo, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, ChevronRight, Copy, FileDiff, FileText, ImageIcon, Lightbulb, ListChecks, Pencil, Terminal, Wand2 } from 'lucide-react'
import { backgroundTaskLabel, formatReplyTime, getLocale, localReplyDay, splitMarkdownBlocks, subscribeToReplyDay, t, workSummaryLabel, type ItemView, type ThreadActivity, type UserInput } from '@qn/codex-client'
import { basename, editUserText, embeddedImageLabel, splitUserText } from '../lib/attachments'
import { copyText } from '../lib/clipboard'
import { cn } from '../lib/cn'
import { diffRows, lineCount, tailLines } from '../lib/diff'
import { langFromClassName } from '../lib/highlight'
import { formatStoppedDuration, isEmptyReasoning, isGroupRunning, summarizeTools, type FlowEntry } from '../lib/turnGroups'
import { createMarkdownLink, FileChangeActions, PathText, qnUrlTransform, type LinkContext } from '../features/files'
import { useCodex } from '../store/codex'
import { CodeBlock } from './CodeBlock'
import { RenderBoundary } from './RenderBoundary'
import { FeedbackRow } from './FeedbackRow'
import { LoadingIcon } from './LoadingIcon'
import { MessageActions } from './MessageActions'
import { MessageImage } from './MessageImage'
import { SubagentDetails } from './SubagentDetails'
import { Badge, IconButton } from './ui'

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
}

/** 当前项目（目标 + 目录）：消息里的本地文件链接、路径按它解析并在文件面板打开。 */
function useLinkContext(): LinkContext | null {
  const targetId = useCodex((s) => s.currentTargetId)
  const cwd = useCodex((s) => s.currentCwd)
  return useMemo(() => (targetId ? { targetId, cwd: cwd ?? '' } : null), [targetId, cwd])
}

function markdownComponents(streaming: boolean, context: LinkContext | null): Components {
  return {
    // 本地文件链接在文件面板打开；外链仍走系统浏览器（main 的 setWindowOpenHandler）。
    a: createMarkdownLink(() => context),
    // 围栏代码块交给 CodeBlock（语言条 + 复制 + shiki 高亮）；行内代码走下面的 code。
    pre: ({ children }) => {
      const child = Children.toArray(children)[0]
      if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre className="qn-pre">{children}</pre>
      return (
        <CodeBlock
          code={plainText(child.props.children)}
          lang={langFromClassName(child.props.className)}
          streaming={streaming}
        />
      )
    },
    code: ({ className, children }) => {
      const text = typeof children === 'string' ? children : null
      return (
        <code className={`rounded-md bg-qn-fg/[0.07] px-1.5 py-0.5 font-mono text-[0.86em] ${className ?? ''}`}>
          {text !== null && context && !streaming ? (
            <PathText text={text} targetId={context.targetId} cwd={context.cwd} />
          ) : (
            children
          )}
        </code>
      )
    },
    table: ({ children }) => (
      <div className="qn-message-table qn-scroll my-3 overflow-x-auto rounded-lg border border-qn-border">
        <table className="w-full border-collapse text-[0.93em]">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border-b border-qn-border bg-qn-fg/[0.03] px-3 py-1.5 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border-b border-qn-border/60 px-3 py-1.5">{children}</td>,
  }
}

const statusTone = (status: string): 'muted' | 'accent' | 'danger' | 'ok' => {
  if (/fail|error|denied|declined/i.test(status)) return 'danger'
  if (/completed|success/i.test(status)) return 'ok'
  if (/progress|running|started/i.test(status)) return 'accent'
  return 'muted'
}

const isRunning = (status: string) => /progress|running|started/i.test(status)
const TOOL_PAGE_SIZE = 30

function ActivityDetails({ summary, summaryClassName, inline, afterChevron, children }: {
  summary: ReactNode
  summaryClassName?: string
  inline?: boolean
  afterChevron?: ReactNode
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const Chevron = inline ? ChevronDown : ChevronRight
  return (
    <details className="text-ui" onToggle={(event) => {
      if (event.target === event.currentTarget) setExpanded(event.currentTarget.open)
    }}>
      <summary className={cn(
        'qn-message-activity min-h-7 cursor-pointer list-none items-center text-qn-muted hover:text-qn-text [&::-webkit-details-marker]:hidden',
        inline ? 'inline-flex gap-1' : 'flex gap-2',
        summaryClassName,
      )}>
        {summary}
        <Chevron size={14} aria-hidden className={cn('shrink-0 text-qn-dim transition-transform', expanded && (inline ? 'rotate-180' : 'rotate-90'))} />
        {afterChevron}
      </summary>
      {expanded && children}
    </details>
  )
}

function ToolPages<T>({ items, renderItem, className }: {
  items: readonly T[]
  renderItem: (item: T, index: number) => ReactNode
  className: string
}) {
  const [page, setPage] = useState(0)
  const lastPage = Math.max(0, Math.ceil(items.length / TOOL_PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  const start = currentPage * TOOL_PAGE_SIZE
  return (
    <>
      {lastPage > 0 && <div className="my-1 flex max-w-72 items-center justify-between gap-2 text-qn-muted">
        <button type="button" className="qn-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('上一批')}</button>
        <span aria-live="polite">{start + 1}–{Math.min(start + TOOL_PAGE_SIZE, items.length)} / {items.length}</span>
        <button type="button" className="qn-button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{t('下一批')}</button>
      </div>}
      <div key={currentPage} className={className}>
        {items.slice(start, start + TOOL_PAGE_SIZE).map((item, index) => renderItem(item, start + index))}
      </div>
    </>
  )
}

/** 工具类条目统一成 Codex 式的可折叠单行：图标 + 一句话摘要，展开看细节。 */
function ToolRow({
  icon,
  summary,
  trailing,
  children,
}: {
  icon: ReactNode
  summary: ReactNode
  trailing?: ReactNode
  children?: ReactNode
}) {
  const content = (
    <>
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      {trailing}
    </>
  )
  if (!children) {
    return (
      <div className="qn-message-activity flex min-h-7 items-center gap-2 text-ui text-qn-muted">
        {content}
      </div>
    )
  }
  return (
    <ActivityDetails summary={content} summaryClassName="rounded-lg">
      <div className="mt-1.5 pl-8">{children}</div>
    </ActivityDetails>
  )
}

function DiffBlock({ text }: { text: string }) {
  const rows = diffRows(text)
  if (rows.length === 0) return null
  const truncated = lineCount(text) > rows.length
  return (
    <div>
      {truncated && <div className="px-2 py-1 text-ui-sm text-qn-dim">{t('仅显示末尾 {count} 行', { count: rows.length })}</div>}
      <pre className="qn-scroll max-h-72 overflow-auto rounded-lg border border-qn-border bg-qn-code py-1 font-mono text-ui-sm leading-5">
        {rows.map((row, index) => (
          <div
            key={index}
            className={`whitespace-pre px-3 ${
              row.kind === 'add'
                ? 'bg-emerald-500/10 text-emerald-300'
                : row.kind === 'remove'
                  ? 'bg-red-500/10 text-red-300'
                  : row.kind === 'meta'
                    ? 'text-qn-dim'
                    : 'text-qn-text/85'
            }`}
          >
            {row.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

function diffStat(diff: string | undefined | null): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++
    else if (line.startsWith('-') && !line.startsWith('---')) del++
  }
  return { add, del }
}

function CommandItem({ item }: { item: Extract<ItemView, { kind: 'command' }> }) {
  const running = isRunning(item.status)
  const failed = item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0
  return (
    <ToolRow
      icon={running ? <LoadingIcon /> : <Terminal size={14} />}
      summary={
        <>
          {running ? `${t('正在运行')} ` : `${t('已运行')} `}
          <code className="font-mono text-ui-sm text-qn-text/90">{item.command || t('（命令）')}</code>
        </>
      }
      trailing={
        failed ? <Badge tone="danger">{t('退出码 {code}', { code: item.exitCode ?? '' })}</Badge> : statusTone(item.status) === 'danger' ? <Badge tone="danger">{item.status}</Badge> : null
      }
    >
      <CommandDetails item={item} running={running} />
    </ToolRow>
  )
}

function CommandDetails({ item, running }: { item: Extract<ItemView, { kind: 'command' }>; running: boolean }) {
  const output = tailLines(item.output, 200)
  const truncated = lineCount(item.output) > 200
  return (
    <>
      {item.cwd && <div className="mb-1 font-mono text-ui-sm text-qn-dim">{item.cwd}</div>}
      {output ? (
        <pre className="qn-scroll max-h-72 overflow-auto whitespace-pre rounded-lg border border-qn-border bg-qn-code px-3 py-2 font-mono text-ui-sm leading-5 text-qn-text/85">
          {truncated && <span className="block text-qn-dim">{t('…（仅显示末尾 200 行）')}</span>}
          {output}
        </pre>
      ) : (
        <div className="text-ui-sm text-qn-dim">{running ? t('等待输出…') : t('无输出')}</div>
      )}
    </>
  )
}

function FileChangeItem({ item }: { item: Extract<ItemView, { kind: 'fileChange' }> }) {
  return (
    <ToolRow
      icon={<FileDiff size={14} />}
      summary={item.changes.length === 0 ? t('等待改动内容…') : t('编辑了 {count} 个文件', { count: item.changes.length })}
    >
      <FileChangeDetails changes={item.changes} />
    </ToolRow>
  )
}

function FileChangeDetails({ changes }: { changes: Extract<ItemView, { kind: 'fileChange' }>['changes'] }) {
  const context = useLinkContext()
  return (
    <ToolPages items={changes} className="space-y-2" renderItem={(change, index) => {
      const { add, del } = diffStat(change.diff)
      return (
        <div key={`${change.path}-${change.kind}-${index}`}>
          <div className="flex items-center gap-2 py-1">
            <span className="min-w-0 truncate font-mono text-ui-sm text-qn-text/90">{change.path}</span>
            <Badge>{change.kind}</Badge>
            <span className="shrink-0 font-mono text-ui-sm">
              {add > 0 && <span className="text-emerald-400">+{add}</span>} {del > 0 && <span className="text-red-400">−{del}</span>}
            </span>
            {context && (
              <FileChangeActions
                targetId={context.targetId}
                cwd={context.cwd || undefined}
                path={change.path}
                {...(typeof change.diff === 'string' ? { diff: change.diff } : {})}
                className="ml-auto"
              />
            )}
          </div>
          {typeof change.diff === 'string' && change.diff !== '' && <DiffBlock text={change.diff} />}
        </div>
      )
    }} />
  )
}

function ReplyTime({ completedAtMs, className }: { completedAtMs: number; className: string }) {
  const day = useSyncExternalStore(subscribeToReplyDay, localReplyDay, localReplyDay)
  const time = formatReplyTime(completedAtMs, day)
  return time && <time className={className} dateTime={time.dateTime} title={time.full}>{time.label}</time>
}

const remarkPlugins = [remarkGfm]

/** 单块 Markdown：memo 后文本和组件不变就跳过重新解析。 */
const MarkdownBlock = memo(function MarkdownBlock({ text, components }: { text: string; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={qnUrlTransform}>
      {text}
    </ReactMarkdown>
  )
})

/** 流式消息按块渲染：已完成的块文本不变、走 memo，每个增量只重新解析末尾一块。 */
function StreamingMarkdown({ text, components }: { text: string; components: Components }) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text])
  return blocks.map((block, index) => <MarkdownBlock key={index} text={block} components={components} />)
}

// 对话实时更新会重建消息操作回调，未变化的正文无需重新解析 Markdown。
const ReplyMarkdown = memo(function ReplyMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const context = useLinkContext()
  const components = useMemo(() => markdownComponents(streaming, context), [streaming, context])
  return (
    // 流式解析失败后继续显示原文，最后一帧再尝试格式化。
    <RenderBoundary
      key={streaming ? 'streaming' : 'complete'}
      fallback={<div className="whitespace-pre-wrap wrap-anywhere">{text}</div>}
    >
      {streaming ? <StreamingMarkdown text={text} components={components} /> : <MarkdownBlock text={text} components={components} />}
    </RenderBoundary>
  )
})

function AgentMessage({ id, text, streaming, completedAtMs, showStreamingDots, onFork }: {
  id: string; text: string; streaming: boolean; completedAtMs?: number; showStreamingDots?: boolean
  onFork?: (itemId: string) => (() => void) | undefined
}) {
  return (
    <div className="group/msg">
      {!streaming && completedAtMs !== undefined && <ReplyTime completedAtMs={completedAtMs} className="mb-1 block text-ui-sm tabular-nums text-qn-muted" />}
      <div className={cn('qn-markdown break-words text-[length:var(--qn-chat-font-size,15px)] leading-[1.7] text-qn-prose', streaming && showStreamingDots && 'qn-streaming')}>
        <ReplyMarkdown text={text} streaming={streaming} />
      </div>
      {!streaming && <MessageActions markdown={text} onContinue={onFork?.(id)} />}
    </div>
  )
}

export function TurnProgress({ activity }: { activity?: ThreadActivity }) {
  const message = activity === 'input' ? t('等待输入…') : activity === 'pending' ? t('等待审批…') : t('正在处理…')
  return (
    <FeedbackRow
      message={message}
      icon={<LoadingIcon />}
      className="qn-message-activity text-ui leading-6 text-qn-muted"
    />
  )
}

export function TurnStopped({ durationMs }: { durationMs: number | null }) {
  const message = durationMs === null ? t('你已停止') : t('你已停止，已用时 {duration}', { duration: formatStoppedDuration(durationMs) })
  return <FeedbackRow message={message} className="qn-message-activity text-ui leading-6 text-qn-muted" />
}

type MessageItemProps = {
  item: ItemView
  showStreamingDots?: boolean
  replyTimeInSummary?: boolean
  onFork?: (itemId: string) => (() => void) | undefined
  onEdit?: (text: string, input: UserInput[]) => Promise<boolean>
  editRestartsConversation?: boolean
  showRevisionMarker?: boolean
}

export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  if (isEmptyReasoning(props.item)) return null
  return <div data-chat-item={props.item.id} className="contents"><MessageContent {...props} /></div>
})

function MessageContent({ item, showStreamingDots, replyTimeInSummary, onFork, onEdit, editRestartsConversation, showRevisionMarker }: MessageItemProps) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} onEdit={item.pending ? undefined : onEdit}
        editRestartsConversation={editRestartsConversation} showRevisionMarker={showRevisionMarker} />
    case 'agent':
      return item.text.trim()
        ? <AgentMessage id={item.id} text={item.text} streaming={item.streaming === true}
          completedAtMs={replyTimeInSummary ? undefined : item.completedAtMs} showStreamingDots={showStreamingDots} onFork={onFork} />
        : null
    case 'reasoning':
      return (
        <ToolRow
          icon={item.streaming ? <LoadingIcon /> : <Lightbulb size={14} strokeWidth={1.75} />}
          summary={item.streaming ? t('正在思考…') : t('思考过程')}
        >
          {item.summary.trim() && (
            <div className="whitespace-pre-wrap break-words border-l border-qn-border pl-3 text-[length:calc(var(--qn-chat-font-size,15px)_-_1px)] leading-[1.8] text-qn-muted">
              {item.summary}
            </div>
          )}
        </ToolRow>
      )
    case 'command':
      return <CommandItem item={item} />
    case 'fileChange':
      return <FileChangeItem item={item} />
    case 'backgroundTask': {
      const label = backgroundTaskLabel(item.status)
      return (
        <ToolRow icon={<ListChecks size={14} aria-hidden />} summary={item.summary ? `${label} · ${item.summary}` : label}>
          {item.result && (
            <div className="qn-markdown min-w-0 wrap-anywhere border-l border-qn-border pl-3 text-qn-prose">
              <ReplyMarkdown text={item.result} streaming={false} />
            </div>
          )}
        </ToolRow>
      )
    }
    case 'subagent':
      return <SubagentDetails item={item} renderItem={(child, showDots) => <MessageItem key={child.id} item={child} showStreamingDots={showDots} />} />
    case 'other':
      if (item.type === 'contextCompaction') {
        return <p role="status" className="text-ui text-qn-muted">{item.summary}</p>
      }
      return (
        <ToolRow icon={<FileText size={14} />} summary={item.type}>
          <div className="whitespace-pre-wrap break-words text-ui text-qn-muted">{item.summary}</div>
        </ToolRow>
      )
  }
}

// 展开状态交给原生 details，避免步骤状态变化时打断用户查看。
export const ToolGroup = memo(function ToolGroup({ items }: { items: ItemView[] }) {
  const running = isGroupRunning(items)
  return (
    <ActivityDetails summary={
      <>
        {running ? <LoadingIcon /> : <ListChecks size={14} />}
        <span className="min-w-0 truncate">{summarizeTools(items)}</span>
      </>
    }>
      <ToolPages items={items} className="mt-1 space-y-0.5 border-l border-qn-border pl-3"
        renderItem={(item) => <MessageItem key={item.id} item={item} />} />
    </ActivityDetails>
  )
})

/** 已结束一轮的过程折叠头（"工作了 4m 56s ⌄"），展开后按原样显示思考与工具步骤。 */
export const WorkGroup = memo(function WorkGroup({
  durationMs,
  replyCompletedAtMs,
  entries,
  onFork,
}: {
  durationMs: number | null
  replyCompletedAtMs?: number
  entries: FlowEntry[]
  onFork?: (itemId: string) => (() => void) | undefined
}) {
  return (
    <ActivityDetails
      inline
      summary={<span>{workSummaryLabel(durationMs)}</span>}
      afterChevron={replyCompletedAtMs !== undefined && <ReplyTime completedAtMs={replyCompletedAtMs} className="ml-2 whitespace-nowrap text-ui-sm tabular-nums text-qn-muted" />}
    >
      <ToolPages items={entries} className="mt-2 space-y-3" renderItem={(entry) => entry.kind === 'tools'
        ? <ToolGroup key={entry.key} items={entry.items} />
        : <MessageItem key={entry.key} item={entry.item} onFork={onFork} />} />
    </ActivityDetails>
  )
})

/** 用户消息：右侧灰色气泡；图片缩略图与附件/技能标签放在气泡上方。 */
function UserMessage({ item, onEdit, editRestartsConversation, showRevisionMarker }: {
  item: Extract<ItemView, { kind: 'user' }>
  onEdit?: (text: string, input: UserInput[]) => Promise<boolean>
  editRestartsConversation?: boolean
  showRevisionMarker?: boolean
}) {
  const [edit, setEdit] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editFailed, setEditFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const parsed = splitUserText(item.text)
  const files = [...(item.files ?? []), ...parsed.files.filter((path) => !item.files?.includes(path))]
  const skills = item.skills?.length ? item.skills : parsed.skills
  // 消息内嵌的图片可以直接预览；目标机路径仅用于显示附件名。
  const images = item.images ?? []
  const visible = images.filter((src) => src.startsWith('data:image/'))
  const named = images.filter((src) => !src.startsWith('data:image/'))
  const revisedText = edit === null || edit === parsed.text ? item.text : editUserText(item.text, edit)
  const hasText = Boolean(revisedText.trim())
  const canSave = Boolean(onEdit) && edit !== null && (hasText || Boolean(item.inputExtras?.length))
  const sentAt = item.sentAt ? new Date(item.sentAt) : null
  const timestamp = sentAt && Number.isFinite(sentAt.getTime()) ? sentAt : null
  const submitLabel = editRestartsConversation ? t('发送修订') : t('重新发送')

  const resend = async () => {
    if (!onEdit || edit === null || !canSave || saving) return
    setSaving(true)
    setEditFailed(false)
    const input: UserInput[] = [...(item.inputExtras ?? [])]
    if (hasText) input.unshift({ type: 'text', text: revisedText, text_elements: [] })
    try {
      if (await onEdit(edit, input)) setEdit(null)
      else setEditFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {showRevisionMarker && (
        <div className="mb-2 flex w-full items-center gap-3 text-ui-sm text-qn-muted">
          <span className="h-px flex-1 bg-qn-border" aria-hidden="true" />
          <span>{t('从这里重新开始')}</span>
          <span className="h-px flex-1 bg-qn-border" aria-hidden="true" />
        </div>
      )}
      {item.steering && <span className="text-ui-sm text-qn-muted">
        {item.steering === 'nextTurn' ? t('引导 · 下一轮') : t('引导 · 当前轮')}
      </span>}
      {visible.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {visible.map((src, index) => (
            <MessageImage key={index} src={src} label={embeddedImageLabel(src, index)} />
          ))}
        </div>
      )}
      {(skills.length > 0 || files.length > 0 || named.length > 0) && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {skills.map((name) => (
            <span key={'s-' + name} className="inline-flex h-6 items-center gap-1 rounded-md bg-qn-brand/10 px-2 text-ui-sm text-qn-brand">
              <Wand2 size={12} /> {name}
            </span>
          ))}
          {named.map((path) => (
            <span key={'i-' + path} title={path} className="inline-flex h-6 max-w-[16rem] items-center gap-1 rounded-md bg-qn-fg/[0.06] px-2 text-ui-sm text-qn-muted">
              <ImageIcon size={12} className="shrink-0" /> <span className="truncate">{basename(path)}</span>
            </span>
          ))}
          {files.map((path) => (
            <span key={'f-' + path} title={path} className="inline-flex h-6 max-w-[16rem] items-center gap-1 rounded-md bg-qn-fg/[0.06] px-2 text-ui-sm text-qn-muted">
              <FileText size={12} className="shrink-0" /> <span className="truncate">{basename(path)}</span>
            </span>
          ))}
        </div>
      )}
      {edit !== null ? (
        <form
          className="w-full max-w-[80%] rounded-2xl border border-qn-outline bg-qn-elevated px-3 py-2 focus-within:border-qn-outline-hover"
          onSubmit={(event) => {
            event.preventDefault()
            void resend()
          }}
        >
          <textarea
            autoFocus
            aria-label={t('编辑已发送的消息')}
            className="qn-scroll block min-h-20 w-full resize-y overflow-x-hidden wrap-anywhere bg-transparent px-1 text-[length:var(--qn-composer-font-size,15px)] leading-[1.7] outline-none"
            wrap="soft"
            value={edit}
            disabled={saving}
            onChange={(event) => setEdit(event.target.value)}
            onMouseUp={(event) => {
              // 消息划选层清除选区时也会重置编辑框的光标。
              event.stopPropagation()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing && !saving) setEdit(null)
            }}
          />
          {editFailed && <div role="status" className="px-1 text-ui-sm text-qn-warn">{t('发送失败，修改已保留')}</div>}
          <div className="mt-2 flex flex-wrap justify-end gap-1.5 text-ui-sm">
            <button type="button" disabled={saving} className="rounded-md px-2 py-1 text-qn-muted hover:bg-qn-hover" onClick={() => setEdit(null)}>{t('取消')}</button>
            <button type="submit" disabled={!canSave || saving} className="rounded-md bg-qn-text px-2 py-1 text-qn-bg disabled:opacity-40">{saving ? t('提交中…') : submitLabel}</button>
          </div>
        </form>
      ) : parsed.text.trim() && (
        <div className="max-w-[80%] whitespace-pre-wrap wrap-anywhere rounded-2xl rounded-br-md border border-qn-fg/[0.06] bg-qn-bubble px-4 py-2.5 text-[length:var(--qn-chat-font-size,15px)] leading-[1.7] text-qn-text">
          {parsed.text}
        </div>
      )}
      {edit === null && (timestamp || parsed.text.trim() || onEdit) && (
        <div className="flex h-6 items-center gap-1 text-ui-sm text-qn-muted">
          {timestamp && <time className="mr-1" dateTime={timestamp.toISOString()}>{timestamp.toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</time>}
          {parsed.text.trim() && (
            <IconButton label={copied ? t('已复制') : t('复制消息')} size="sm" onClick={() => void copyText(parsed.text).then((ok) => {
              setCopied(ok)
              if (ok) window.setTimeout(() => setCopied(false), 1600)
            })}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          )}
          {onEdit && (
            <IconButton label={t('编辑消息')} size="sm" onClick={() => {
              setEditFailed(false)
              setEdit(parsed.text)
            }}>
              <Pencil size={14} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  )
}

