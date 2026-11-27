import { Check, ChevronRight, CircleX, ClipboardType, Copy, FilePen, Image, ListChecks, Pencil, Quote, Terminal } from 'lucide-react'
import { editUserText, formatReplyTime, localReplyDay, splitUserText, subscribeToReplyDay, type ItemView, type UserInput } from '@qn/codex-client'
import { createContext, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toolStatus, toolSummary, type ToolItem, type ToolStatus } from '../chatGroups'
import { allowLocalUrl, isImagePath, parseFileHref, resolvePath, segmentPaths, type FileLocation } from '../fileLinks'
import { callDevice } from '../client'
import { getWindowNativePort } from '../native'
import { ImageThumbnail } from './ImageThumbnail'
import { SubagentDetails } from './SubagentDetails'
import { Badge, Button, Dialog, LoadingIcon } from './ui'

/** 消息里的路径按会话 cwd 解析，点击后在只读查看页打开；没有提供时路径只是普通文本。 */
export type FileActions = {
  cwd: string
  openFile: (location: FileLocation) => void
  openDiff: (path: string, diff?: string) => void
}

export const FileActionsContext = createContext<FileActions | null>(null)

function ReplyTime({ completedAtMs }: { completedAtMs: number }) {
  const day = useSyncExternalStore(subscribeToReplyDay, localReplyDay, localReplyDay)
  const time = formatReplyTime(completedAtMs, day)
  return time && <time className="mb-1 block text-xs tabular-nums text-qn-muted" dateTime={time.dateTime} title={time.full}>{time.label}</time>
}

const LinkedImageContext = createContext(false)
const RASTER_IMAGE_URL = /^data:image\/(?:jpeg|png|gif|webp);base64,/i
const WEB_IMAGE_URL = /^(?:https?:)?\/\//i
const MESSAGE_IMAGE_CLASS = 'max-h-36 max-w-full rounded-lg object-contain'
const TOOL_PAGE_SIZE = 30

function LazyDetails({ className, summary, children }: { className: string; summary: ReactNode; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <details className={className} onToggle={(event) => {
      if (event.target === event.currentTarget) setExpanded(event.currentTarget.open)
    }}>
      {summary}
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
      {lastPage > 0 && <div className="flex items-center justify-between gap-1 px-2 text-qn-muted">
        <Button variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一批</Button>
        <span aria-live="polite">{start + 1}–{Math.min(start + TOOL_PAGE_SIZE, items.length)} / {items.length}</span>
        <Button variant="ghost" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一批</Button>
      </div>}
      <div key={currentPage} className={className}>
        {items.slice(start, start + TOOL_PAGE_SIZE).map((item, index) => renderItem(item, start + index))}
      </div>
    </>
  )
}

const urlTransform = (value: string, key: string): string =>
  key === 'src' && RASTER_IMAGE_URL.test(value) ? value : allowLocalUrl(value, defaultUrlTransform(value))

function MessageImage({ src, alt }: { src: string; alt: string }) {
  const actions = useContext(FileActionsContext)
  const linked = useContext(LinkedImageContext)
  const external = WEB_IMAGE_URL.test(src)
  if (external || RASTER_IMAGE_URL.test(src)) {
    // Markdown 图片若已包在链接内，沿用链接动作，避免嵌套交互目标。
    return linked
      ? <img src={src} alt={alt} className={MESSAGE_IMAGE_CLASS} loading="lazy" />
      : <ImageThumbnail src={src} alt={alt} className={MESSAGE_IMAGE_CLASS} loading="lazy" externalHref={external ? src : undefined} />
  }
  const location = actions && !linked ? parseFileHref(src, actions.cwd) : null
  if (actions && location && isImagePath(location.path)) {
    return (
      <Button variant="ghost" className="max-w-full" onClick={() => actions.openFile(location)} aria-label={`查看图片：${alt}`}>
        <Image size={16} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{alt}</span>
      </Button>
    )
  }
  return <Badge>{alt}</Badge>
}

/** 行内代码里的 `src/a.ts:42` 之类片段变成可点链接。 */
function PathText({ text, actions }: { text: string; actions: FileActions }) {
  const segments = segmentPaths(text)
  if (!segments.some((segment) => segment.match)) return <>{text}</>
  return (
    <>
      {segments.map((segment, index) => {
        const match = segment.match
        if (!match) return <span key={index}>{segment.text}</span>
        const location = parseFileHref(match.raw, actions.cwd) ?? { path: resolvePath(match.path, actions.cwd) }
        return (
          <button
            key={index}
            type="button"
            className="qn-path-link"
            onClick={() => actions.openFile({ ...location, ...(match.line ? { line: match.line } : {}) })}
          >
            {segment.text}
          </button>
        )
      })}
    </>
  )
}

function markdownComponents(actions: FileActions | null, streaming: boolean): Components {
  return {
    // 空 href 会让 WebView 重新加载对话，因此只有能处理的地址才保留点击动作。
    a: ({ href, children }) => {
      if (!href) return children
      const linked = <LinkedImageContext.Provider value>{children}</LinkedImageContext.Provider>
      if (WEB_IMAGE_URL.test(href) || /^(?:https?|mailto|tel):/i.test(href)) {
        return <a href={href} target="_blank" rel="noreferrer" className="text-qn-accent underline">{linked}</a>
      }
      if (href.startsWith('#')) return <a href={href} className="text-qn-accent underline">{linked}</a>
      const location = actions ? parseFileHref(href, actions.cwd) : null
      if (!actions || !location) return children
      return <button type="button" className="qn-path-link" onClick={() => actions.openFile(location)}>{linked}</button>
    },
    img: ({ src, alt }) => <MessageImage src={src ?? ''} alt={alt || '图片'} />,
    pre: ({ children }) => <pre className="qn-pre">{children}</pre>,
    code: ({ className, children }) => (
      <code className={`rounded bg-black/40 px-1 font-mono text-[12px] ${className ?? ''}`}>
        {/* 流式输出时文本还在变，等完成后再识别路径，避免链接闪动。 */}
        {actions && !streaming && typeof children === 'string' ? <PathText text={children} actions={actions} /> : children}
      </code>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="my-2 w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-qn-border px-2 py-1 text-left">{children}</th>,
    td: ({ children }) => <td className="border border-qn-border px-2 py-1">{children}</td>,
  }
}

function Markdown({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const actions = useContext(FileActionsContext)
  const components = useMemo(() => markdownComponents(actions, streaming), [actions, streaming])
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  )
}

const statusTone = (status: string): 'muted' | 'accent' | 'danger' | 'ok' => {
  if (/fail|error|denied|declined/i.test(status)) return 'danger'
  if (/completed|success/i.test(status)) return 'ok'
  if (/progress|running|started/i.test(status)) return 'accent'
  return 'muted'
}

function DiffBlock({ text }: { text: string }) {
  const all = text.split('\n')
  const lines = all.length > 200 ? all.slice(-200) : all
  return (
    <div>
      {all.length > lines.length && (
        <div className="mb-1 text-[10px] text-qn-muted">仅显示末尾 {lines.length} 行</div>
      )}
      <pre className="qn-pre qn-scroll qn-diff-preview text-[11px] leading-5" tabIndex={0}>
        {lines.map((line, index) => {
          const tone = line.startsWith('+')
            ? 'text-emerald-300'
            : line.startsWith('-')
              ? 'text-red-300'
              : line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')
                ? 'text-qn-muted'
                : ''
          return (
            <div key={index} className={tone}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

function MessageActions({ text, onQuote, getPlainText, onEdit }: {
  text: string; onQuote?: (text: string) => void; getPlainText?: () => string; onEdit?: () => void
}) {
  const [status, setStatus] = useState('')
  const hasText = Boolean(text.trim())
  if (!hasText && !onEdit) return null

  async function copy(value: string) {
    try {
      if (getWindowNativePort()) await callDevice('clipboard.write', { text: value })
      else await navigator.clipboard.writeText(value)
      setStatus('已复制')
    } catch {
      setStatus('复制失败，可长按选中文字后复制')
    }
  }

  const copyLabel = getPlainText ? '复制 Markdown' : '复制文本'
  return (
    <div className="mt-1 w-full">
      <div className="flex items-center justify-end gap-1">
        {onEdit && (
          <Button variant="ghost" className="qn-icon-button" aria-label="编辑并重发" title="编辑并重发" onClick={onEdit}>
            <Pencil size={18} aria-hidden />
          </Button>
        )}
        {hasText && getPlainText && (
          <Button variant="ghost" className="qn-icon-button" aria-label="复制纯文本" title="复制纯文本"
            onClick={() => void copy(getPlainText())}>
            <ClipboardType size={18} aria-hidden />
          </Button>
        )}
        {hasText && onQuote && (
          <Button variant="ghost" className="qn-icon-button" aria-label="引用到对话" title="引用到对话"
            onClick={() => onQuote(text.slice(0, 4000))}>
            <Quote size={18} aria-hidden />
          </Button>
        )}
        {hasText && (
          <Button variant="ghost" className="qn-icon-button" aria-label={copyLabel} title={copyLabel}
            onClick={() => void copy(text)}>
            <Copy size={18} aria-hidden />
          </Button>
        )}
      </div>
      {status && <p className="text-right text-xs text-qn-muted" role="status">{status}</p>}
    </div>
  )
}

function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'running') return <LoadingIcon className="text-qn-accent" role="img" aria-hidden={false} aria-label="运行中" />
  if (status === 'failed') return <CircleX size={14} className="shrink-0 text-qn-danger" aria-label="失败" />
  return <Check size={14} className="shrink-0 text-qn-dim" aria-label="完成" />
}

function CommandItem({
  item,
  onQuote,
}: {
  item: Extract<ItemView, { kind: 'command' }>
  onQuote?: (text: string) => void
}) {
  const status = toolStatus(item)
  return (
    <LazyDetails className="qn-tool" summary={
      <summary className="qn-tool-row">
        <Terminal size={14} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{status === 'running' ? '正在运行 ' : '已运行 '}<code className="qn-mono">{item.command || '（命令）'}</code></span>
        {status === 'failed' && typeof item.exitCode === 'number' && <span className="text-qn-danger">退出码 {item.exitCode}</span>}
        <ToolStatusIcon status={status} />
        <ChevronRight size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
      </summary>
    }>
      <CommandDetails item={item} status={status} onQuote={onQuote} />
    </LazyDetails>
  )
}

function CommandDetails({ item, status, onQuote }: {
  item: Extract<ItemView, { kind: 'command' }>
  status: ToolStatus
  onQuote?: (text: string) => void
}) {
  const text = item.output
  const all = text.split('\n')
  const output = all.length > 200 ? all.slice(-200).join('\n') : text
  return (
    <div className="qn-tool-body">
      <div className="qn-mono whitespace-pre-wrap break-all text-[12px]">$ {item.command || '（命令）'}</div>
      {item.cwd && <div className="qn-mono mt-1 text-[10px] text-qn-muted">{item.cwd}</div>}
      {output && (
        <pre className="qn-pre qn-scroll qn-command-output mt-2 overflow-auto whitespace-pre text-[11px] leading-5">
          {all.length > 200 && <span className="text-qn-muted">（只显示末尾 200 行）{'\n'}</span>}
          {output}
        </pre>
      )}
      {!output && <div className="mt-2 text-xs text-qn-muted">{status === 'running' ? '等待输出…' : '无输出'}</div>}
      <MessageActions text={item.command || text} onQuote={onQuote} />
    </div>
  )
}

/** 连续工具步骤折叠后的摘要行，展开后逐条显示。 */
export function ToolGroup({ items, onQuote }: { items: ToolItem[]; onQuote: (text: string) => void }) {
  const running = items.some((item) => toolStatus(item) === 'running')
  return (
    <LazyDetails className="qn-tool-group" summary={
      <summary className="qn-tool-row">
        {running ? <LoadingIcon className="text-qn-accent" /> : <ListChecks size={14} className="shrink-0 text-qn-muted" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{toolSummary(items)}</span>
        <ChevronRight size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
      </summary>
    }>
      <ToolPages items={items} className="qn-tool-group-body qn-scroll mt-1 space-y-1"
        renderItem={(item) => <MessageItem key={item.id} item={item} onQuote={onQuote} />} />
    </LazyDetails>
  )
}

function FileChangeItem({
  item,
  onQuote,
}: {
  item: Extract<ItemView, { kind: 'fileChange' }>
  onQuote?: (text: string) => void
}) {
  return (
    <LazyDetails className="qn-tool" summary={
      <summary className="qn-tool-row">
        <FilePen size={14} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">文件改动{item.changes.length > 0 && ` · ${item.changes.length} 个文件`}</span>
        <Badge tone={statusTone(item.status)}>{item.status}</Badge>
        <ChevronRight size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
      </summary>
    }>
      <FileChangeDetails item={item} onQuote={onQuote} />
    </LazyDetails>
  )
}

function FileChangeDetails({ item, onQuote }: {
  item: Extract<ItemView, { kind: 'fileChange' }>
  onQuote?: (text: string) => void
}) {
  const actions = useContext(FileActionsContext)
  return (
    <div className="qn-tool-body">
      {item.changes.length === 0 && <div className="text-qn-muted">等待改动内容…</div>}
      <ToolPages items={item.changes} className="space-y-2" renderItem={(change, index) => (
        <div key={`${change.path}-${change.kind}-${index}`} className="mb-2">
          <div className="flex items-center gap-2 py-1">
            {actions && change.path && change.kind !== 'output' ? (
              <button
                type="button"
                className="qn-path-link qn-mono min-w-0 flex-1 truncate text-left text-[11px]"
                onClick={() => actions.openFile({ path: resolvePath(change.path, actions.cwd) })}
              >
                {change.path}
              </button>
            ) : (
              <span className="qn-mono min-w-0 flex-1 truncate text-[11px]">{change.path}</span>
            )}
            <Badge>{change.kind}</Badge>
          </div>
          {actions && change.path && change.kind !== 'output' && (
            <div className="mb-1 flex justify-end">
              <Button
                variant="ghost"
                className="px-3 py-1 text-[11px]"
                onClick={() =>
                  actions.openDiff(resolvePath(change.path, actions.cwd), typeof change.diff === 'string' ? change.diff : undefined)
                }
              >
                查看差异
              </Button>
            </div>
          )}
          {typeof change.diff === 'string' && change.diff !== '' && <DiffBlock text={change.diff} />}
        </div>
      )} />
      <MessageActions text={item.changes.map((change) => change.path).join('\n')} onQuote={onQuote} />
    </div>
  )
}

type Resend = (text: string, attachments: UserInput[]) => Promise<boolean>

function UserMessage({ item, onQuote, onResend }: {
  item: Extract<ItemView, { kind: 'user' }>
  onQuote?: (text: string) => void
  onResend?: Resend
}) {
  const [edit, setEdit] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const parsed = splitUserText(item.text)
  const attachments = item.inputExtras ?? []
  const localImage = attachments.some((item) => item.type === 'localImage')
  const revised = edit === null ? '' : editUserText(item.text, edit)
  const canSave = edit !== null && edit !== parsed.text && !localImage && Boolean(revised.trim() || attachments.length)

  async function submit() {
    if (!onResend || !canSave || saving) return
    setSaving(true)
    setFailed(false)
    try {
      if (await onResend(revised, attachments)) setEdit(null)
      else setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-end">
      <div className="qn-user-bubble">
        <div className="whitespace-pre-wrap break-words">{item.text}</div>
        {item.images && item.images.length > 0 && <div className="mt-1 flex flex-wrap gap-2">
          {item.images.map((url, index) => <MessageImage key={index} src={url} alt={`附件图片 ${index + 1}`} />)}
        </div>}
      </div>
      <MessageActions text={item.text} onQuote={onQuote} onEdit={onResend ? () => { setFailed(false); setEdit(parsed.text) } : undefined} />
      {edit !== null && (
        <Dialog title="编辑并重发" onClose={() => { if (!saving) setEdit(null) }}>
          <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <textarea className="qn-input w-full resize-y" aria-label="修改消息" rows={4} value={edit}
              disabled={saving} onChange={(event) => setEdit(event.target.value)} />
            {localImage && <p className="mt-2 text-xs text-qn-warn">此消息含目标机本地图片，请在电脑上重发。</p>}
            {failed && <p className="mt-2 text-xs text-qn-warn" role="status">发送失败，修改已保留。</p>}
            <Button type="submit" variant="primary" className="mt-3 w-full" disabled={!canSave || saving}>
              {saving ? '提交中…' : '发送修订'}
            </Button>
          </form>
        </Dialog>
      )}
    </div>
  )
}

export function MessageItem({
  item,
  onQuote,
  agentName,
  active,
  showStreamingDots,
  onResend,
}: {
  item: ItemView
  onQuote?: (text: string) => void
  agentName?: string
  active?: boolean
  showStreamingDots?: boolean
  onResend?: Resend
}) {
  const markdownRef = useRef<HTMLDivElement>(null)
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} onQuote={onQuote} onResend={item.pending ? undefined : onResend} />
    case 'agent':
      return (
        <div className="px-1 py-1" aria-label={agentName}>
          {!item.streaming && item.completedAtMs !== undefined && item.text.trim() && <ReplyTime completedAtMs={item.completedAtMs} />}
          <div ref={markdownRef} className={`qn-markdown break-words text-sm${item.streaming && showStreamingDots ? ' qn-streaming' : ''}`}>
            <Markdown text={item.text} streaming={item.streaming === true} />
          </div>
          <MessageActions text={item.text} onQuote={onQuote} getPlainText={() => markdownRef.current?.innerText ?? item.text} />
        </div>
      )
    case 'reasoning':
      return (
        <LazyDetails className="rounded-xl border border-qn-border bg-black/10 px-3 py-2 text-xs" summary={
          <summary className="flex items-center gap-2 text-qn-muted">
            <span>◌ 推理摘要</span>
            {item.streaming && <Badge tone="accent">进行中</Badge>}
          </summary>
        }>
          <div className="mt-2 whitespace-pre-wrap break-words leading-5 text-qn-text/90">
            {item.summary || '（暂无摘要）'}
          </div>
          <MessageActions text={item.summary} onQuote={onQuote} />
        </LazyDetails>
      )
    case 'command':
      return <CommandItem item={item} onQuote={onQuote} />
    case 'fileChange':
      return <FileChangeItem item={item} onQuote={onQuote} />
    case 'subagent':
      return (
        <SubagentDetails item={item} renderItem={(child, showDots) => (
          <FileActionsContext.Provider key={child.id} value={null}><MessageItem item={child} showStreamingDots={showDots} /></FileActionsContext.Provider>
        )} />
      )
    case 'other':
      if (item.type === 'contextCompaction') {
        const busy = item.status === 'inProgress'
        if (busy && !active) return null
        return <div className="qn-thinking" role="status">{busy ? <LoadingIcon /> : <Check size={14} aria-hidden />}{item.summary}</div>
      }
      return (
        <div className="qn-tool qn-tool-open text-xs">
          <div className="mb-1 text-[11px] text-qn-muted">{item.type}</div>
          <div className="whitespace-pre-wrap break-words">{item.summary}</div>
          <MessageActions text={item.summary} onQuote={onQuote} />
        </div>
      )
  }
}
