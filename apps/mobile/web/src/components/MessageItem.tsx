import { Check, ChevronRight, CircleX, Ellipsis, FilePen, ListChecks, LoaderCircle, Terminal } from 'lucide-react'
import type { ItemView } from '@qn/codex-client'
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toolStatus, toolSummary, type ToolItem, type ToolStatus } from '../chatGroups'
import { allowLocalUrl, parseFileHref, resolvePath, segmentPaths, type FileLocation } from '../fileLinks'
import { callDevice } from '../client'
import { getWindowNativePort } from '../native'
import { Badge, Button, Dialog } from './ui'

/** 消息里的路径按会话 cwd 解析，点击后在只读查看页打开；没有提供时路径只是普通文本。 */
export type FileActions = {
  cwd: string
  openFile: (location: FileLocation) => void
  openDiff: (path: string, diff?: string) => void
}

export const FileActionsContext = createContext<FileActions | null>(null)

const urlTransform = (value: string): string => allowLocalUrl(value, defaultUrlTransform(value))

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
    // 本地文件链接在查看页打开；外链由 Android WebView 交给系统浏览器，页面自身不访问外网。
    a: ({ href, children }) => {
      const location = actions && href && !/^https?:/i.test(href) ? parseFileHref(href, actions.cwd) : null
      if (!actions || !location) {
        return (
          <a href={href} target="_blank" rel="noreferrer" className="text-qn-accent underline">
            {children}
          </a>
        )
      }
      return (
        <a
          href={href}
          className="text-qn-accent underline"
          onClick={(event) => {
            event.preventDefault()
            actions.openFile(location)
          }}
        >
          {children}
        </a>
      )
    },
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
      <pre className="qn-pre qn-scroll max-h-64 overflow-auto text-[11px] leading-5">
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

function MessageActions({ text, onQuote, getPlainText }: {
  text: string; onQuote: (text: string) => void; getPlainText?: () => string
}) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('')
  if (!text.trim()) return null

  async function copy(value: string) {
    try {
      if (getWindowNativePort()) await callDevice('clipboard.write', { text: value })
      else await navigator.clipboard.writeText(value)
      setOpen(false)
      setStatus('已复制')
    } catch {
      setStatus('复制失败，可长按选中文字后复制')
    }
  }

  return (
    <div className="mt-1 flex items-center justify-end gap-1">
      {status && <span className="text-xs text-qn-muted" role="status">{status}</span>}
      <Button variant="ghost" className="qn-icon-button qn-message-more" aria-label="消息操作" onClick={() => { setStatus(''); setOpen(true) }}><Ellipsis size={18} /></Button>
      {open && (
        <Dialog title="消息操作" onClose={() => setOpen(false)}>
          <div className="grid gap-1">
            <Button variant="ghost" onClick={() => { onQuote(text.slice(0, 4000)); setOpen(false) }}>引用到对话</Button>
            <Button variant="ghost" onClick={() => void copy(text)}>{getPlainText ? '复制 Markdown' : '复制文本'}</Button>
            {getPlainText && <Button variant="ghost" onClick={() => void copy(getPlainText())}>复制纯文本</Button>}
            {status && <p className="text-xs text-qn-warn" role="alert">{status}</p>}
          </div>
        </Dialog>
      )}
    </div>
  )
}

function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'running') return <LoaderCircle size={14} className="qn-spin shrink-0 text-qn-accent" aria-label="运行中" />
  if (status === 'failed') return <CircleX size={14} className="shrink-0 text-qn-danger" aria-label="失败" />
  return <Check size={14} className="shrink-0 text-qn-dim" aria-label="完成" />
}

function CommandItem({
  item,
  onQuote,
}: {
  item: Extract<ItemView, { kind: 'command' }>
  onQuote: (text: string) => void
}) {
  const all = item.output.split('\n')
  const output = all.length > 200 ? all.slice(-200).join('\n') : item.output
  const status = toolStatus(item)
  return (
    <details className="qn-tool">
      <summary className="qn-tool-row">
        <Terminal size={14} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="qn-mono min-w-0 flex-1 truncate">{item.command || '（命令）'}</span>
        {status === 'failed' && typeof item.exitCode === 'number' && <span className="text-qn-danger">退出码 {item.exitCode}</span>}
        <ToolStatusIcon status={status} />
      </summary>
      <div className="qn-tool-body">
        <div className="qn-mono whitespace-pre-wrap break-all text-[12px]">$ {item.command || '（命令）'}</div>
        {item.cwd && <div className="qn-mono mt-1 text-[10px] text-qn-muted">{item.cwd}</div>}
        {output && (
          <pre className="qn-pre qn-scroll mt-2 max-h-64 overflow-auto whitespace-pre text-[11px] leading-5">
            {all.length > 200 && <span className="text-qn-muted">（只显示末尾 200 行）{'\n'}</span>}
            {output}
          </pre>
        )}
        <MessageActions text={item.command || item.output} onQuote={onQuote} />
      </div>
    </details>
  )
}

/** 连续工具步骤折叠后的摘要行，展开后逐条显示。 */
export function ToolGroup({ items, onQuote }: { items: ToolItem[]; onQuote: (text: string) => void }) {
  const running = items.some((item) => toolStatus(item) === 'running')
  return (
    <details className="qn-tool-group">
      <summary className="qn-tool-row">
        {running ? <LoaderCircle size={14} className="qn-spin shrink-0 text-qn-accent" aria-hidden /> : <ListChecks size={14} className="shrink-0 text-qn-muted" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{toolSummary(items)}</span>
        <ChevronRight size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
      </summary>
      <div className="mt-1 space-y-1">
        {items.map((item) => <MessageItem key={item.id} item={item} onQuote={onQuote} />)}
      </div>
    </details>
  )
}

function FileChangeItem({
  item,
  onQuote,
}: {
  item: Extract<ItemView, { kind: 'fileChange' }>
  onQuote: (text: string) => void
}) {
  const actions = useContext(FileActionsContext)
  return (
    <div className="qn-tool qn-tool-open text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <FilePen size={14} className="text-qn-muted" aria-hidden />
        <span>文件改动</span>
        <Badge tone={statusTone(item.status)}>{item.status}</Badge>
      </div>
      {item.changes.length === 0 && <div className="text-qn-muted">等待改动内容…</div>}
      {item.changes.map((change, index) => (
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
      ))}
      <MessageActions text={item.changes.map((change) => change.path).join('\n')} onQuote={onQuote} />
    </div>
  )
}

export function MessageItem({
  item,
  onQuote,
  agentName,
}: {
  item: ItemView
  onQuote: (text: string) => void
  agentName?: string
}) {
  const markdownRef = useRef<HTMLDivElement>(null)
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end">
          <div className="qn-user-bubble">
            <div className="whitespace-pre-wrap break-words">{item.text}</div>
            {item.images && item.images.length > 0 && <div className="mt-1 flex flex-wrap gap-2">
              {item.images.map((url, index) => /^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(url)
                ? <img key={index} src={url} className="max-h-36 max-w-full rounded-lg object-contain" alt={`附件图片 ${index + 1}`} loading="lazy" />
                : <Badge key={index}>图片 {index + 1}</Badge>)}
            </div>}
          </div>
          <MessageActions text={item.text} onQuote={onQuote} />
        </div>
      )
    case 'agent':
      return (
        <div className="px-1 py-1" aria-label={agentName}>
          <div ref={markdownRef} className="qn-markdown break-words text-sm">
            <Markdown text={item.text} streaming={item.streaming === true} />
            {item.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-qn-accent align-middle" />}
          </div>
          <MessageActions text={item.text} onQuote={onQuote} getPlainText={() => markdownRef.current?.innerText ?? item.text} />
        </div>
      )
    case 'reasoning':
      return (
        <details className="rounded-xl border border-qn-border bg-black/10 px-3 py-2 text-xs">
          <summary className="flex items-center gap-2 text-qn-muted">
            <span>◌ 推理摘要</span>
            {item.streaming && <Badge tone="accent">进行中</Badge>}
          </summary>
          <div className="mt-2 whitespace-pre-wrap break-words leading-5 text-qn-text/90">
            {item.summary || '（暂无摘要）'}
          </div>
          <MessageActions text={item.summary} onQuote={onQuote} />
        </details>
      )
    case 'command':
      return <CommandItem item={item} onQuote={onQuote} />
    case 'fileChange':
      return <FileChangeItem item={item} onQuote={onQuote} />
    case 'subagent':
      return (
        <div className="qn-tool qn-tool-open text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span>{item.title}</span>
            {item.status && <Badge>{item.status}</Badge>}
          </div>
          {item.detail && <div className="mt-1 whitespace-pre-wrap break-words text-qn-muted">{item.detail}</div>}
        </div>
      )
    case 'other':
      return (
        <div className="qn-tool qn-tool-open text-xs">
          <div className="mb-1 text-[11px] text-qn-muted">{item.type}</div>
          <div className="whitespace-pre-wrap break-words">{item.summary}</div>
          <MessageActions text={item.summary} onQuote={onQuote} />
        </div>
      )
  }
}
