import { Children, isValidElement, memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, ChevronRight, Copy, FileDiff, FileText, ImageIcon, Lightbulb, ListChecks, LoaderCircle, Pencil, Terminal, Wand2 } from 'lucide-react'
import type { ItemView, UserInput } from '@qn/codex-client'
import { basename, editUserText, splitUserText } from '../lib/attachments'
import { copyText } from '../lib/clipboard'
import { cn } from '../lib/cn'
import { diffRows, lineCount, tailLines } from '../lib/diff'
import { langFromClassName } from '../lib/highlight'
import { formatDuration, isGroupRunning, summarizeTools, type FlowEntry } from '../lib/turnGroups'
import { createMarkdownLink, FileChangeActions, PathText, qnUrlTransform, type LinkContext } from '../features/files'
import { useCodex } from '../store/codex'
import { CodeBlock } from './CodeBlock'
import { MessageActions } from './MessageActions'
import { MessageImage } from './MessageImage'
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
        <code className={`rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.86em] ${className ?? ''}`}>
          {text !== null && context && !streaming ? (
            <PathText text={text} targetId={context.targetId} cwd={context.cwd} />
          ) : (
            children
          )}
        </code>
      )
    },
    table: ({ children }) => (
      <div className="qn-scroll my-3 overflow-x-auto rounded-lg border border-qn-border">
        <table className="w-full border-collapse text-[13px]">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border-b border-qn-border bg-white/[0.03] px-3 py-1.5 text-left font-medium">{children}</th>,
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
  if (!children) {
    return (
      <div className="flex min-h-7 items-center gap-2 text-[13px] text-qn-muted">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {trailing}
      </div>
    )
  }
  return (
    <details className="group/tool text-[13px]">
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-lg text-qn-muted hover:text-qn-text [&::-webkit-details-marker]:hidden">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {trailing}
        <ChevronRight size={14} className="shrink-0 text-qn-dim transition-transform group-open/tool:rotate-90" />
      </summary>
      <div className="mt-1.5 pl-6">{children}</div>
    </details>
  )
}

function DiffBlock({ text }: { text: string }) {
  const rows = diffRows(text)
  if (rows.length === 0) return null
  const truncated = lineCount(text) > rows.length
  return (
    <div>
      {truncated && <div className="px-2 py-1 text-[12px] text-qn-dim">仅显示末尾 {rows.length} 行</div>}
      <pre className="qn-scroll max-h-72 overflow-auto rounded-lg border border-qn-border bg-[#141414] py-1 font-mono text-[12px] leading-5">
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
  const output = tailLines(item.output, 200)
  const truncated = lineCount(item.output) > 200
  const running = isRunning(item.status)
  const failed = item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0
  return (
    <ToolRow
      icon={running ? <LoaderCircle size={14} className="animate-spin text-qn-brand" /> : <Terminal size={14} />}
      summary={
        <>
          {running ? '正在运行 ' : '已运行 '}
          <code className="font-mono text-[12.5px] text-qn-text/90">{item.command || '（命令）'}</code>
        </>
      }
      trailing={
        failed ? <Badge tone="danger">退出码 {item.exitCode}</Badge> : statusTone(item.status) === 'danger' ? <Badge tone="danger">{item.status}</Badge> : null
      }
    >
      {item.cwd && <div className="mb-1 font-mono text-[12px] text-qn-dim">{item.cwd}</div>}
      {output ? (
        <pre className="qn-scroll max-h-72 overflow-auto whitespace-pre rounded-lg border border-qn-border bg-[#141414] px-3 py-2 font-mono text-[12px] leading-5 text-qn-text/85">
          {truncated && <span className="block text-qn-dim">…（仅显示末尾 200 行）</span>}
          {output}
        </pre>
      ) : (
        <div className="text-[12px] text-qn-dim">{running ? '等待输出…' : '无输出'}</div>
      )}
    </ToolRow>
  )
}

function FileChangeItem({ item }: { item: Extract<ItemView, { kind: 'fileChange' }> }) {
  const context = useLinkContext()
  const stats = item.changes.map((change) => diffStat(change.diff))
  const add = stats.reduce((sum, stat) => sum + stat.add, 0)
  const del = stats.reduce((sum, stat) => sum + stat.del, 0)
  return (
    <ToolRow
      icon={<FileDiff size={14} />}
      summary={item.changes.length === 0 ? '等待改动内容…' : `编辑了 ${item.changes.length} 个文件`}
      trailing={
        <span className="shrink-0 font-mono text-[12px]">
          {add > 0 && <span className="text-emerald-400">+{add}</span>} {del > 0 && <span className="text-red-400">−{del}</span>}
        </span>
      }
    >
      <div className="space-y-2">
        {item.changes.map((change, index) => (
          <div key={`${change.path}-${change.kind}-${index}`}>
            <div className="flex items-center gap-2 py-1">
              <span className="min-w-0 truncate font-mono text-[12.5px] text-qn-text/90">{change.path}</span>
              <Badge>{change.kind}</Badge>
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
        ))}
      </div>
    </ToolRow>
  )
}

function AgentMessage({ id, text, streaming, onFork }: { id: string; text: string; streaming: boolean; onFork?: (itemId: string, markdown: string) => void }) {
  const context = useLinkContext()
  const components = useMemo(() => markdownComponents(streaming, context), [streaming, context])
  return (
    <div className="group/msg">
      <div className={cn('qn-markdown break-words text-[14px] leading-[1.7] text-qn-prose', streaming && 'qn-streaming')}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={qnUrlTransform}>
          {text}
        </ReactMarkdown>
      </div>
      {!streaming && <MessageActions markdown={text} onFork={onFork ? () => onFork(id, text) : undefined} />}
    </div>
  )
}

export const MessageItem = memo(function MessageItem({
  item,
  onFork,
  onEdit,
}: {
  item: ItemView
  onFork?: (itemId: string, markdown: string) => void
  onEdit?: (text: string, input: UserInput[]) => Promise<boolean>
}) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} onEdit={item.pending ? undefined : onEdit} />
    case 'agent':
      return <AgentMessage id={item.id} text={item.text} streaming={item.streaming === true} onFork={onFork} />
    case 'reasoning':
      return (
        <ToolRow
          icon={<Lightbulb size={14} strokeWidth={1.75} className={item.streaming ? 'animate-pulse text-qn-brand' : ''} />}
          summary={item.streaming ? '正在思考…' : '思考过程'}
        >
          <div className="whitespace-pre-wrap break-words border-l border-qn-border pl-3 text-[13px] leading-6 text-qn-muted">
            {item.summary || '（暂无摘要）'}
          </div>
        </ToolRow>
      )
    case 'command':
      return <CommandItem item={item} />
    case 'fileChange':
      return <FileChangeItem item={item} />
    case 'other':
      return (
        <ToolRow icon={<FileText size={14} />} summary={item.type}>
          <div className="whitespace-pre-wrap break-words text-[13px] text-qn-muted">{item.summary}</div>
        </ToolRow>
      )
  }
})

// 展开状态交给原生 details，避免步骤状态变化时打断用户查看。
export const ToolGroup = memo(function ToolGroup({ items }: { items: ItemView[] }) {
  const running = isGroupRunning(items)
  return (
    <details className="group/steps text-[13px]">
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 text-qn-muted hover:text-qn-text [&::-webkit-details-marker]:hidden">
        {running ? <LoaderCircle size={14} className="animate-spin text-qn-brand" /> : <ListChecks size={14} />}
        <span className="min-w-0 truncate">{summarizeTools(items)}</span>
        <ChevronRight size={14} className="shrink-0 text-qn-dim transition-transform group-open/steps:rotate-90" />
      </summary>
      <div className="mt-1 space-y-0.5 border-l border-qn-border pl-3">
        {items.map((item) => (
          <MessageItem key={item.id} item={item} />
        ))}
      </div>
    </details>
  )
})

/** 已结束一轮的过程折叠头（"工作了 4m 56s ⌄"），展开后按原样显示思考与工具步骤。 */
export const WorkGroup = memo(function WorkGroup({
  durationMs,
  entries,
  onFork,
}: {
  durationMs: number | null
  entries: FlowEntry[]
  onFork?: (itemId: string, markdown: string) => void
}) {
  return (
    <details className="group/work text-[13px]">
      <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 text-qn-muted hover:text-qn-text [&::-webkit-details-marker]:hidden">
        <span>{durationMs ? `工作了 ${formatDuration(durationMs)}` : '工作过程'}</span>
        <ChevronDown size={14} className="shrink-0 text-qn-dim transition-transform group-open/work:rotate-180" />
      </summary>
      <div className="mt-2 space-y-3">
        {entries.map((entry) =>
          entry.kind === 'tools' ? (
            <ToolGroup key={entry.key} items={entry.items} />
          ) : (
            <MessageItem key={entry.key} item={entry.item} onFork={onFork} />
          ),
        )}
      </div>
    </details>
  )
})

/** 用户消息：右侧灰色气泡；图片缩略图与附件/技能标签放在气泡上方。 */
function UserMessage({ item, onEdit }: {
  item: Extract<ItemView, { kind: 'user' }>
  onEdit?: (text: string, input: UserInput[]) => Promise<boolean>
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
  const canSave = edit !== null && edit !== parsed.text && Boolean(edit.trim() || item.inputExtras?.length || parsed.files.length)
  const timestamp = item.sentAt ? new Date(item.sentAt) : null

  const resend = async () => {
    if (!onEdit || edit === null || !canSave || saving) return
    setSaving(true)
    setEditFailed(false)
    const text = editUserText(item.text, edit)
    const input: UserInput[] = [...(item.inputExtras ?? [])]
    if (text.trim()) input.unshift({ type: 'text', text, text_elements: [] })
    try {
      if (await onEdit(edit, input)) setEdit(null)
      else setEditFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {visible.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {visible.map((src, index) => (
            <MessageImage key={index} src={src} label={`图片 ${index + 1}`} />
          ))}
        </div>
      )}
      {(skills.length > 0 || files.length > 0 || named.length > 0) && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {skills.map((name) => (
            <span key={'s-' + name} className="inline-flex h-6 items-center gap-1 rounded-md bg-qn-brand/10 px-2 text-[12px] text-qn-brand">
              <Wand2 size={12} /> {name}
            </span>
          ))}
          {named.map((path) => (
            <span key={'i-' + path} title={path} className="inline-flex h-6 max-w-[16rem] items-center gap-1 rounded-md bg-white/[0.06] px-2 text-[12px] text-qn-muted">
              <ImageIcon size={12} className="shrink-0" /> <span className="truncate">{basename(path)}</span>
            </span>
          ))}
          {files.map((path) => (
            <span key={'f-' + path} title={path} className="inline-flex h-6 max-w-[16rem] items-center gap-1 rounded-md bg-white/[0.06] px-2 text-[12px] text-qn-muted">
              <FileText size={12} className="shrink-0" /> <span className="truncate">{basename(path)}</span>
            </span>
          ))}
        </div>
      )}
      {edit !== null ? (
        <form
          className="w-full max-w-[80%] rounded-2xl border border-qn-border bg-qn-elevated px-3 py-2 focus-within:border-qn-border-strong"
          onSubmit={(event) => {
            event.preventDefault()
            void resend()
          }}
        >
          <textarea
            ref={(area) => { area?.focus() }}
            aria-label="编辑已发送的消息"
            className="qn-scroll block min-h-20 w-full resize-y bg-transparent px-1 text-[14px] leading-6 outline-none"
            value={edit}
            disabled={saving}
            onChange={(event) => setEdit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing && !saving) setEdit(null)
            }}
          />
          {editFailed && <div role="status" className="px-1 text-[12px] text-qn-warn">发送失败，修改已保留</div>}
          <div className="mt-2 flex flex-wrap justify-end gap-1.5 text-[12px]">
            <button type="button" disabled={saving} className="rounded-md px-2 py-1 text-qn-muted hover:bg-qn-hover" onClick={() => setEdit(null)}>取消</button>
            <button type="submit" disabled={!canSave || saving} className="rounded-md bg-qn-text px-2 py-1 text-black disabled:opacity-40">{saving ? '提交中…' : '发送修订'}</button>
          </div>
        </form>
      ) : parsed.text.trim() && (
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-qn-elevated px-4 py-2.5 text-[14px] leading-6 text-qn-prose">
          {parsed.text}
        </div>
      )}
      {edit === null && (timestamp || parsed.text.trim() || onEdit) && (
        <div className="flex h-6 items-center gap-1 text-[12px] text-qn-muted">
          {timestamp && <time className="mr-1" dateTime={timestamp.toISOString()}>{timestamp.toLocaleString('zh-CN', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</time>}
          {parsed.text.trim() && (
            <IconButton label={copied ? '已复制' : '复制消息'} size="sm" onClick={() => void copyText(parsed.text).then((ok) => {
              setCopied(ok)
              if (ok) window.setTimeout(() => setCopied(false), 1600)
            })}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          )}
          {onEdit && (
            <IconButton label="编辑消息" size="sm" onClick={() => {
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

