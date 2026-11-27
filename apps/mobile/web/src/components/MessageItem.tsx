import { Check, ChevronRight, CircleX, Copy, Ellipsis, FileCode, FilePen, GitCompare, Image, ListChecks, Pencil, Quote, Terminal } from 'lucide-react'
import { editUserText, splitUserText, type ItemView, type UserInput } from '@qn/codex-client'
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toolStatus, toolSummary, type ToolItem, type ToolStatus } from '../chatGroups'
import { allowLocalUrl, isImagePath, parseFileHref, resolvePath, segmentPaths, type FileLocation } from '../fileLinks'
import { callDevice } from '../client'
import { getWindowNativePort } from '../native'
import { ImageThumbnail } from './ImageThumbnail'
import { SubagentDetails } from './SubagentDetails'
import { Badge, Button, Dialog, LoadingIcon, SheetAction } from './ui'

/** 消息里的路径按会话 cwd 解析，点击后在只读查看页打开；没有提供时路径只是普通文本。 */
export type FileActions = {
  cwd: string
  openFile: (location: FileLocation) => void
  openDiff: (path: string, diff?: string) => void
}

export const FileActionsContext = createContext<FileActions | null>(null)

const LinkedImageContext = createContext(false)
const RASTER_IMAGE_URL = /^data:image\/(?:jpeg|png|gif|webp);base64,/i
const WEB_IMAGE_URL = /^(?:https?:)?\/\//i
const MESSAGE_IMAGE_CLASS = 'max-h-36 max-w-full rounded-lg object-contain'

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

function MessageActions({ text, onQuote, getPlainText, onEdit, open: controlledOpen, onOpenChange, hideTrigger = false }: {
  text: string; onQuote?: (text: string) => void; getPlainText?: () => string; onEdit?: () => void
  open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = (value: boolean) => { if (onOpenChange) onOpenChange(value); else setOwnOpen(value) }
  const [status, setStatus] = useState('')
  const hasText = Boolean(text.trim())
  if (!hasText && !onEdit) return null
  if (hideTrigger && !open && !status) return null

  async function copy(value: string) {
    try {
      if (getWindowNativePort()) await callDevice('clipboard.write', { text: value })
      else await navigator.clipboard.writeText(value)
      setOpen(false)
      setStatus('已复制')
      window.setTimeout(() => setStatus((current) => current === '已复制' ? '' : current), 1600)
    } catch {
      setStatus('复制失败，可长按选中文字后复制')
    }
  }

  return (
    <div className="qn-message-actions">
      {status && <span className="text-xs text-qn-muted" role="status">{status}</span>}
      {!hideTrigger && <Button variant="ghost" className="qn-icon-button qn-message-more" aria-label="消息操作" onClick={() => { setStatus(''); setOpen(true) }}><Ellipsis size={16} /></Button>}
      {open && (
        <Dialog title="消息操作" onClose={() => setOpen(false)}>
          <div className="grid gap-1">
            {hasText && <SheetAction icon={Copy} onClick={() => void copy(getPlainText ? getPlainText() : text)}>复制</SheetAction>}
            {hasText && getPlainText && <SheetAction icon={FileCode} onClick={() => void copy(text)}>复制 Markdown 源文</SheetAction>}
            {hasText && onQuote && <SheetAction icon={Quote} onClick={() => { onQuote(text.slice(0, 4000)); setOpen(false) }}>引用到对话</SheetAction>}
            {onEdit && <SheetAction icon={Pencil} onClick={() => { setOpen(false); onEdit() }}>编辑并重发</SheetAction>}
            {status && <p className="text-xs text-qn-warn" role="alert">{status}</p>}
          </div>
        </Dialog>
      )}
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
  const all = item.output.split('\n')
  const output = all.length > 200 ? all.slice(-200).join('\n') : item.output
  const status = toolStatus(item)
  return (
    <details className="qn-tool">
      <summary className="qn-tool-row">
        <Terminal size={14} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{status === 'running' ? '正在运行 ' : '已运行 '}<code className="qn-mono">{item.command || '（命令）'}</code></span>
        {status === 'failed' && typeof item.exitCode === 'number' && <span className="text-qn-danger">退出码 {item.exitCode}</span>}
        <ToolStatusIcon status={status} />
        <ChevronRight size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
      </summary>
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
        <MessageActions text={item.command || item.output} onQuote={onQuote} />
      </div>
    </details>
  )
}

/** 连续工具步骤折叠后的摘要行，展开后逐条显示。 */
export function ToolGroup({ items, onQuote, trail = false }: { items: ToolItem[]; onQuote: (text: string) => void; trail?: boolean }) {
  const running = items.some((item) => toolStatus(item) === 'running')
  const failed = items.some((item) => toolStatus(item) === 'failed')
  return (
    <details className={`qn-tool-group${trail ? ' qn-tool-trail' : ''}${failed ? ' qn-tool-failed' : ''}`}>
      <summary className="qn-tool-row">
        {running ? <LoadingIcon className="text-qn-accent" />
          : failed ? <CircleX size={14} className="shrink-0 text-qn-danger" aria-hidden />
            : <ListChecks size={14} className="shrink-0 text-qn-muted" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{toolSummary(items)}</span>
        <ChevronRight size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
      </summary>
      <div className="qn-tool-group-body qn-scroll mt-1 space-y-1">
        {items.map((item) => <MessageItem key={item.id} item={item} onQuote={onQuote} />)}
      </div>
    </details>
  )
}

const CHANGE_KIND: Record<string, { label: string; tone: string }> = {
  add: { label: '新增', tone: 'text-qn-ok' },
  create: { label: '新增', tone: 'text-qn-ok' },
  update: { label: '修改', tone: 'text-qn-accent' },
  modify: { label: '修改', tone: 'text-qn-accent' },
  delete: { label: '删除', tone: 'text-qn-danger' },
  remove: { label: '删除', tone: 'text-qn-danger' },
  move: { label: '移动', tone: 'text-qn-warn' },
  rename: { label: '重命名', tone: 'text-qn-warn' },
}

/** 统计 unified diff 的增删行数，文件头不计入。 */
export function diffStat(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return added || removed ? { added, removed } : null
}

function splitPath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

function FileChangeItem({
  item,
}: {
  item: Extract<ItemView, { kind: 'fileChange' }>
  onQuote?: (text: string) => void
}) {
  const actions = useContext(FileActionsContext)
  const status = toolStatus(item)
  const files = item.changes.filter((change) => change.kind !== 'output')
  // 手机屏幕有限，只列文件清单；差异点右侧按钮全屏查看。
  return (
    <div className="qn-tool qn-tool-open qn-file-change">
      <div className="qn-file-change-head">
        <FilePen size={14} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {status === 'running' ? '正在改动' : status === 'failed' ? '改动未完成' : '已改动'}
          {files.length > 0 && ` ${files.length} 个文件`}
        </span>
        <ToolStatusIcon status={status} />
      </div>
      {item.changes.length === 0 && <div className="px-1 pb-1 text-qn-muted">等待改动内容…</div>}
      {item.changes.map((change, index) => {
        const kind = CHANGE_KIND[change.kind.toLowerCase()]
        const stat = diffStat(change.diff)
        const { dir, name } = splitPath(change.path)
        const linked = Boolean(actions && change.path && change.kind !== 'output')
        return (
          <div key={`${change.path}-${change.kind}-${index}`} className="qn-file-change-row">
            <div className="flex min-h-9 items-center gap-2">
              {kind && <span className={`shrink-0 text-[11px] font-semibold ${kind.tone}`}>{kind.label}</span>}
              {linked && actions ? (
                <button type="button" className="qn-file-change-path" title={change.path}
                  onClick={() => actions.openFile({ path: resolvePath(change.path, actions.cwd) })}>
                  <span className="qn-file-change-dir">{dir}</span><span className="qn-file-change-name">{name}</span>
                </button>
              ) : (
                <span className="qn-file-change-path" title={change.path}>
                  <span className="qn-file-change-dir">{dir}</span><span className="qn-file-change-name">{name}</span>
                </span>
              )}
              {stat && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums">
                  <span className="text-qn-ok">+{stat.added}</span> <span className="text-qn-danger">−{stat.removed}</span>
                </span>
              )}
              {linked && actions && (
                <Button variant="ghost" className="qn-file-change-diff" aria-label={`查看 ${name} 的差异`}
                  onClick={() => actions.openDiff(resolvePath(change.path, actions.cwd), typeof change.diff === 'string' ? change.diff : undefined)}>
                  <GitCompare size={15} aria-hidden />
                </Button>
              )}
            </div>
          </div>
        )
      })}
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
  const [menu, setMenu] = useState(false)
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
      {/* 用户消息不常驻「⋯」：长按气泡（或右键）打开操作，减少消息流里的按钮噪音。 */}
      <div className="qn-user-bubble" onContextMenu={(event) => {
        event.preventDefault()
        navigator.vibrate?.(10)
        setMenu(true)
      }}>
        <div className="whitespace-pre-wrap break-words">{item.text}</div>
        {item.images && item.images.length > 0 && <div className="mt-1 flex flex-wrap gap-2">
          {item.images.map((url, index) => <MessageImage key={index} src={url} alt={`附件图片 ${index + 1}`} />)}
        </div>}
      </div>
      <MessageActions text={item.text} onQuote={onQuote} hideTrigger open={menu} onOpenChange={setMenu}
        onEdit={onResend ? () => { setFailed(false); setEdit(parsed.text) } : undefined} />
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
  onResend,
  showActions = true,
}: {
  item: ItemView
  onQuote?: (text: string) => void
  agentName?: string
  active?: boolean
  onResend?: Resend
  /** 只在每轮最后一条回复下常驻操作入口；中间的过程说明不再逐条挂「⋯」。 */
  showActions?: boolean
}) {
  const markdownRef = useRef<HTMLDivElement>(null)
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} onQuote={onQuote} onResend={item.pending ? undefined : onResend} />
    case 'agent':
      return (
        <div className="px-1 py-1" aria-label={agentName}>
          {/* 流式光标画在最后一个块的行尾（CSS），不单独占一行。 */}
          <div ref={markdownRef} className={`qn-markdown break-words text-sm${item.streaming ? ' qn-streaming' : ''}`}>
            <Markdown text={item.text} streaming={item.streaming === true} />
          </div>
          {showActions && !item.streaming && (
            <MessageActions text={item.text} onQuote={onQuote} getPlainText={() => markdownRef.current?.innerText ?? item.text} />
          )}
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
        <SubagentDetails item={item} renderItem={(child) => (
          <FileActionsContext.Provider key={child.id} value={null}><MessageItem item={child} /></FileActionsContext.Provider>
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
