import { Check, ChevronDown, ChevronRight, CircleX, Copy, Ellipsis, FileCode, FilePen, FileText, GitCompare, Image, ListChecks, Pencil, Quote, Split, Terminal } from 'lucide-react'
import { backgroundTaskLabel, editUserText, formatReplyTime, localReplyDay, splitMarkdownBlocks, splitUserText, subscribeToReplyDay, workSummaryLabel, type ItemView, type UserInput, getLocale, t, translateMessage } from '@qn/codex-client'
import { createContext, Fragment, memo, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toolStatus, toolSummary, type ToolStatus, type WorkGroupEntry } from '../chatGroups'
import { allowLocalUrl, isImagePath, parseFileHref, resolvePath, segmentPaths, type FileLocation } from '../fileLinks'
import { copyText } from '../client'
import { ImageThumbnail } from './ImageThumbnail'
import { SubagentDetails } from './SubagentDetails'
import { TerminalIcon } from './TerminalIcon'
import { Badge, Button, Dialog, LoadingIcon, SheetAction } from './ui'

/** 消息里的路径按会话 cwd 解析，点击后在只读查看页打开；没有提供时路径只是普通文本。 */
export type FileActions = {
  cwd: string
  openFile: (location: FileLocation) => void
  openDiff: (path: string, diff?: string) => void
}

export const FileActionsContext = createContext<FileActions | null>(null)

function ReplyTime({ completedAtMs, inline = false }: { completedAtMs: number; inline?: boolean }) {
  const day = useSyncExternalStore(subscribeToReplyDay, localReplyDay, localReplyDay)
  const time = formatReplyTime(completedAtMs, day)
  return time && <time className={`${inline ? 'shrink-0 whitespace-nowrap' : 'mb-1 block'} text-xs tabular-nums text-qn-muted`}
    dateTime={time.dateTime} title={time.full}>{time.label}</time>
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
        <Button variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('上一批')}</Button>
        <span aria-live="polite">{start + 1}–{Math.min(start + TOOL_PAGE_SIZE, items.length)} / {items.length}</span>
        <Button variant="ghost" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{t('下一批')}</Button>
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
      <Button variant="ghost" className="max-w-full" onClick={() => actions.openFile(location)} aria-label={t('查看图片：{alt}', { alt })}>
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
    img: ({ src, alt }) => <MessageImage src={src ?? ''} alt={alt || t('图片')} />,
    pre: ({ children }) => <pre className="qn-pre">{children}</pre>,
    code: ({ className, children }) => (
      <code className={`rounded border border-qn-border bg-qn-field px-1 font-mono text-[length:var(--text-xs)] ${className ?? ''}`}>
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

const remarkPlugins = [remarkGfm]

/** 单块 Markdown：memo 后文本和组件不变就跳过重新解析。 */
const MarkdownBlock = memo(function MarkdownBlock({ text, components }: { text: string; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  )
})

/**
 * 消息 Markdown。memo：会话里任一消息更新都会重渲染整列消息，文本没变的不必重新解析。
 * 流式时按块渲染，已完成的块走缓存，每个增量只重新解析末尾一块；结束后整条解析一次。
 */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const actions = useContext(FileActionsContext)
  const components = useMemo(() => markdownComponents(actions, streaming), [actions, streaming])
  const blocks = useMemo(() => streaming ? splitMarkdownBlocks(text) : null, [streaming, text])
  if (!blocks) return <MarkdownBlock text={text} components={components} />
  return blocks.map((block, index) => <MarkdownBlock key={index} text={block} components={components} />)
})

function DiffBlock({ text }: { text: string }) {
  const all = text.split('\n')
  const lines = all.length > 200 ? all.slice(-200) : all
  return (
    <div>
      {all.length > lines.length && (
        <div className="mb-1 text-3xs text-qn-muted">{t('仅显示末尾 {count} 行', { count: lines.length })}</div>
      )}
      <pre className="qn-pre qn-scroll qn-diff-preview" tabIndex={0}>
        {lines.map((line, index) => {
          const tone = line.startsWith('+')
            ? 'text-qn-diff-add'
            : line.startsWith('-')
              ? 'text-qn-diff-remove'
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

function MessageActions({ text, onQuote, getPlainText, onEdit, onFork, open: controlledOpen, onOpenChange, hideTrigger = false }: {
  text: string; onQuote?: (text: string) => void; getPlainText?: () => string; onEdit?: () => void; onFork?: () => void
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
      await copyText(value)
      setStatus(t('已复制'))
      window.setTimeout(() => setStatus((current) => current === t('已复制') ? '' : current), 1600)
    } catch {
      setStatus(t('复制失败，可长按选中文字后复制'))
    }
  }

  return (
    <div className="qn-message-actions">
      {status && <span className="text-xs text-qn-muted" role="status">{status}</span>}
      {!hideTrigger && <Button variant="ghost" className="qn-icon-button qn-message-more" aria-label={t('消息操作')} onClick={() => { setStatus(''); setOpen(true) }}><Ellipsis size={16} /></Button>}
      {open && (
        <Dialog title={t('消息操作')} onClose={() => setOpen(false)}>
          <div className="qn-sheet-actions">
            {hasText && <SheetAction icon={Copy} onClick={() => void copy(getPlainText ? getPlainText() : text)}>{getPlainText ? t('复制纯文本') : t('复制文本')}</SheetAction>}
            {hasText && getPlainText && <SheetAction icon={FileCode} onClick={() => void copy(text)}>{t('复制 Markdown 源文')}</SheetAction>}
            {hasText && onQuote && <SheetAction icon={Quote} onClick={() => { onQuote(text.slice(0, 4000)); setOpen(false) }}>{t('引用到对话')}</SheetAction>}
            {onFork && <SheetAction icon={Split} onClick={() => { setOpen(false); onFork() }}>{t('新建对话继续')}</SheetAction>}
            {onEdit && <SheetAction icon={Pencil} onClick={() => { setOpen(false); onEdit() }}>{t('编辑并重发')}</SheetAction>}
            {status && <p className="text-xs text-qn-warn" role="alert">{status}</p>}
          </div>
        </Dialog>
      )}
    </div>
  )
}

function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'running') return <LoadingIcon className="text-qn-accent" role="img" aria-hidden={false} aria-label={t('运行中')} />
  if (status === 'failed') return <CircleX size={14} className="shrink-0 text-qn-danger" aria-label={t('失败')} />
  return <Check size={14} className="shrink-0 text-qn-dim" aria-label={t('完成')} />
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
        <TerminalIcon running={status === 'running'} className={status === 'running' ? '' : 'text-qn-muted'} />
        <span className="min-w-0 flex-1 truncate">{status === 'running' ? t('正在运行 ') : t('已运行 ')}<code className="qn-mono">{item.command || t('（命令）')}</code></span>
        {status === 'failed' && typeof item.exitCode === 'number' && <span className="text-qn-danger">{t('退出码 {code}', { code: item.exitCode })}</span>}
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
      <div className="qn-mono whitespace-pre-wrap break-all text-[length:var(--text-xs)]">$ {item.command || t('（命令）')}</div>
      {item.cwd && <div className="qn-mono mt-1 text-3xs text-qn-muted">{item.cwd}</div>}
      {output && (
        <pre className="qn-pre qn-scroll qn-command-output mt-2 overflow-auto whitespace-pre">
          {all.length > 200 && <span className="text-qn-muted">{t('（只显示末尾 200 行）')}{'\n'}</span>}
          {output}
        </pre>
      )}
      {!output && <div className="mt-2 text-xs text-qn-muted">{status === 'running' ? t('等待输出…') : t('无输出')}</div>}
      <MessageActions text={item.command || text} onQuote={onQuote} />
    </div>
  )
}

/** 连续工具步骤折叠后的摘要行，展开后逐条显示。 */
export function ToolGroup({ items, onQuote, trail = false }: {
  items: ItemView[]; onQuote: (text: string) => void; trail?: boolean
}) {
  const running = items.some((item) => toolStatus(item) === 'running')
  const failed = items.some((item) => toolStatus(item) === 'failed')
  // 与电脑版一致：含命令的分组用终端图标，运行中由图标动效表示；失败时随整行标红。
  const hasCommands = items.some((item) => item.kind === 'command')
  return (
    <LazyDetails className={`qn-tool-group${trail ? ' qn-tool-trail' : ''}${failed ? ' qn-tool-failed' : ''}`} summary={
      <summary className="qn-tool-row">
        {hasCommands ? <TerminalIcon running={running} />
          : running ? <LoadingIcon className="text-qn-accent" />
          : failed ? <CircleX size={14} className="shrink-0 text-qn-danger" aria-hidden />
            : <ListChecks size={14} className="shrink-0 text-qn-muted" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{toolSummary(items)}</span>
        <ChevronRight size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
      </summary>
    }>
      <ToolPages items={items} className="qn-tool-group-body qn-scroll mt-1 space-y-1"
        renderItem={(item) => <MessageItem key={item.id} item={item} onQuote={onQuote} />} />
    </LazyDetails>
  )
}

export function WorkGroup({ work, onQuote }: { work: WorkGroupEntry; onQuote: (text: string) => void }) {
  return (
    <LazyDetails className="qn-tool-group qn-work-group" summary={
      <summary className="qn-tool-row">
        <span>{workSummaryLabel(work.durationMs)}</span>
        <ChevronDown size={14} className="qn-tool-chevron shrink-0 text-qn-dim" aria-hidden />
        {work.reply?.completedAtMs !== undefined && <ReplyTime completedAtMs={work.reply.completedAtMs} inline />}
      </summary>
    }>
      <ToolPages items={work.entries} className="space-y-2"
        renderItem={(entry) => entry.kind === 'tools'
          ? <ToolGroup key={entry.key} items={entry.items} onQuote={onQuote} />
          : <MessageItem key={entry.key} item={entry.item} onQuote={onQuote} showActions={false} />} />
    </LazyDetails>
  )
}

const CHANGE_KIND: Record<string, { label: string; tone: string }> = {
  add: { label: t('新增'), tone: 'text-qn-ok' },
  create: { label: t('新增'), tone: 'text-qn-ok' },
  update: { label: t('修改'), tone: 'text-qn-accent' },
  modify: { label: t('修改'), tone: 'text-qn-accent' },
  // i18n-ignore: 改动类型用过去式，同一原文在按钮上译作 Delete
  delete: { label: getLocale() === 'en' ? 'Deleted' : '删除', tone: 'text-qn-danger' },
  // i18n-ignore: 同上
  remove: { label: getLocale() === 'en' ? 'Deleted' : '删除', tone: 'text-qn-danger' },
  move: { label: t('移动'), tone: 'text-qn-warn' },
  // i18n-ignore: 改动类型用过去式，同一原文在按钮上译作 Rename
  rename: { label: getLocale() === 'en' ? 'Renamed' : '重命名', tone: 'text-qn-warn' },
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
  onQuote,
}: {
  item: Extract<ItemView, { kind: 'fileChange' }>
  onQuote?: (text: string) => void
}) {
  const status = toolStatus(item)
  const fileCount = item.changes.filter((change) => change.kind !== 'output').length
  return (
    <LazyDetails className="qn-tool qn-file-change" summary={
      <summary className="qn-file-change-head qn-tool-row">
        <FilePen size={14} className="shrink-0 text-qn-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {status === 'running' ? t('正在改动') : status === 'failed' ? t('改动未完成') : t('已改动')}
          {fileCount > 0 && ` ${fileCount === 1 ? t('1 个文件') : t('{count} 个文件', { count: fileCount })}`}
        </span>
        <ToolStatusIcon status={status} />
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
      {item.changes.length === 0 && <div className="px-1 pb-1 text-qn-muted">{t('等待改动内容…')}</div>}
      <ToolPages items={item.changes} className="space-y-2" renderItem={(change, index) => {
        const kind = CHANGE_KIND[change.kind.toLowerCase()]
        const diff = change.diff ?? undefined
        const stat = diffStat(diff)
        const { dir, name } = splitPath(change.path)
        const linked = Boolean(actions && change.path && change.kind !== 'output')
        return (
          <div key={`${change.path}-${change.kind}-${index}`} className="qn-file-change-row">
            <div className="flex min-h-9 items-center gap-2">
              {kind && <span className={`shrink-0 text-2xs font-semibold ${kind.tone}`}>{kind.label}</span>}
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
                <span className="shrink-0 font-mono text-2xs tabular-nums">
                  <span className="text-qn-ok">+{stat.added}</span> <span className="text-qn-danger">−{stat.removed}</span>
                </span>
              )}
              {linked && actions && (
                <Button variant="ghost" className="qn-file-change-diff" aria-label={t('查看 {name} 的差异', { name })}
                  onClick={() => actions.openDiff(resolvePath(change.path, actions.cwd), diff)}>
                  <GitCompare size={15} aria-hidden />
                </Button>
              )}
            </div>
            {diff && <DiffBlock text={diff} />}
          </div>
        )
      }} />
      <MessageActions text={item.changes.map((change) => change.path).join('\n')} onQuote={onQuote} />
    </div>
  )
}

type Resend = (text: string, attachments: UserInput[]) => Promise<boolean>

/** 用户消息超过 8 行或 600 字时折叠（参考 Orca 手机版），粘贴的大段日志不再占满屏幕。 */
export function isLongUserText(text: string): boolean {
  return text.length > 600 || text.split('\n').length > 8
}

function UserMessage({ item, onQuote, onResend }: {
  item: Extract<ItemView, { kind: 'user' }>
  onQuote?: (text: string) => void
  onResend?: Resend
}) {
  const [expanded, setExpanded] = useState(false)
  const [edit, setEdit] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const parsed = splitUserText(item.text)
  // 与电脑版一致：发送中的气泡和 Codex 用 skill 输入项，Claude 回显把技能写在正文开头。
  const skills = item.skills?.length ? item.skills : parsed.skills
  const files = [...new Set([...(item.files ?? []), ...parsed.files])]
  const hasBody = Boolean(parsed.text) || skills.length > 0
  const long = isLongUserText(parsed.text)
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
      {item.steering && <span className="mb-1 text-xs text-qn-muted">
        {item.steering === 'nextTurn' ? t('引导 · 下一轮') : t('引导 · 当前轮')}
      </span>}
      {/* 用户消息不常驻「⋯」：长按气泡（或右键）打开操作，减少消息流里的按钮噪音。 */}
      <div className="qn-user-bubble" onContextMenu={(event) => {
        event.preventDefault()
        navigator.vibrate?.(10)
        setMenu(true)
      }}>
        {files.length > 0 && <div className={`flex flex-wrap gap-1.5${hasBody ? ' mb-1' : ''}`}>
          {files.map((path) => (
            <span key={`f-${path}`} title={path} className="inline-flex max-w-full items-center gap-1 rounded-md bg-qn-bg px-2 text-xs leading-6 text-qn-muted">
              <FileText size={12} className="shrink-0" aria-hidden /> <span className="truncate">{path.split(/[\\/]/).pop() || path}</span>
            </span>
          ))}
        </div>}
        {/* 技能与正文连在一起，和输入框里的 /名字 写法一致；只发技能时气泡仍在，长按操作不丢。 */}
        {hasBody && <div className={`whitespace-pre-wrap break-words${long && !expanded ? ' line-clamp-8' : ''}`}>
          {skills.map((name, index) => (
            <Fragment key={name}>{index > 0 && ' '}<span className="qn-user-skill font-medium text-qn-accent">/{name}</span></Fragment>
          ))}
          {skills.length > 0 && parsed.text && ' '}{parsed.text}
        </div>}
        {long && (
          <button type="button" className="qn-fold-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? t('收起') : t('展开全文')}
          </button>
        )}
        {item.images && item.images.length > 0 && <div className="mt-1 flex flex-wrap gap-2">
          {item.images.map((url, index) => <MessageImage key={index} src={url} alt={t('附件图片 {index}', { index: index + 1 })} />)}
        </div>}
      </div>
      <MessageActions text={item.text} onQuote={onQuote} hideTrigger open={menu} onOpenChange={setMenu}
        onEdit={onResend ? () => { setFailed(false); setEdit(parsed.text) } : undefined} />
      {edit !== null && (
        <Dialog title={t('编辑并重发')} onClose={() => { if (!saving) setEdit(null) }}>
          <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <textarea className="qn-input w-full resize-y" aria-label={t('修改消息')} rows={4} value={edit}
              disabled={saving} onChange={(event) => setEdit(event.target.value)} />
            {localImage && <p className="mt-2 text-xs text-qn-warn">{t('此消息含目标机本地图片，请在电脑上重发。')}</p>}
            {failed && <p className="mt-2 text-xs text-qn-warn" role="status">{t('发送失败，修改已保留。')}</p>}
            <Button type="submit" variant="primary" className="mt-3 w-full" disabled={!canSave || saving}>
              {saving ? t('提交中…') : t('发送修订')}
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
  onFork,
  showActions = true,
  replyTimeInSummary = false,
}: {
  item: ItemView
  onQuote?: (text: string) => void
  agentName?: string
  active?: boolean
  showStreamingDots?: boolean
  onResend?: Resend
  /** 从这条回复所在轮次分叉；仅回复消息使用。 */
  onFork?: () => void
  /** 只在每轮最后一条回复下常驻操作入口；中间的过程说明不再逐条挂「⋯」。 */
  showActions?: boolean
  replyTimeInSummary?: boolean
}) {
  const markdownRef = useRef<HTMLDivElement>(null)
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} onQuote={onQuote} onResend={item.pending ? undefined : onResend} />
    case 'agent':
      return (
        <div className="px-1 py-1" aria-label={agentName}>
          {!replyTimeInSummary && !item.streaming && item.completedAtMs !== undefined && item.text.trim() && <ReplyTime completedAtMs={item.completedAtMs} />}
          <div ref={markdownRef} className={`qn-markdown break-words text-sm${item.streaming && showStreamingDots ? ' qn-streaming' : ''}`}>
            <Markdown text={item.text} streaming={item.streaming === true} />
          </div>
          {showActions && !item.streaming && (
            <MessageActions text={item.text} onQuote={onQuote} getPlainText={() => markdownRef.current?.innerText ?? item.text} onFork={onFork} />
          )}
        </div>
      )
    case 'reasoning':
      return (
        <LazyDetails className="rounded-xl border border-qn-border bg-qn-card px-3 py-2 text-xs" summary={
          <summary className="flex items-center gap-2 text-qn-muted">
            <span>{t('◌ 推理摘要')}</span>
            {item.streaming && <Badge tone="accent">{t('进行中')}</Badge>}
          </summary>
        }>
          <div className="mt-2 whitespace-pre-wrap break-words leading-5 text-qn-text/90">
            {item.summary || t('（暂无摘要）')}
          </div>
          <MessageActions text={item.summary} onQuote={onQuote} />
        </LazyDetails>
      )
    case 'command':
      return <CommandItem item={item} onQuote={onQuote} />
    case 'fileChange':
      return <FileChangeItem item={item} onQuote={onQuote} />
    case 'notice':
      // 本机提示（如中途切换模型）：居中细线分隔，不当作消息或工具步骤。
      return (
        <div role="status" className="flex items-center gap-3 py-1 text-xs text-qn-muted">
          <span className="h-px flex-1 bg-qn-border" aria-hidden />
          <span className="min-w-0 truncate">{item.text}</span>
          <span className="h-px flex-1 bg-qn-border" aria-hidden />
        </div>
      )
    case 'backgroundTask': {
      const label = backgroundTaskLabel(item.status)
      // Claude 的后台任务通知可能把整段结果放进摘要：标题最多两行，全文收进展开区，避免一条通知占满屏幕。
      const longSummary = item.summary.length > 80 || item.summary.includes('\n')
      const body = item.result || (longSummary ? item.summary : '')
      const header = <>
        <ListChecks size={14} className="shrink-0" aria-hidden />
        <span className={`min-w-0 flex-1 wrap-anywhere line-clamp-2${item.result ? ' group-open:line-clamp-none' : ''}`}>
          {item.summary ? `${label} · ${item.summary}` : label}
        </span>
      </>
      const row = 'flex min-h-11 items-center gap-2 px-3 py-1.5 text-qn-muted'
      const surface = 'min-w-0 rounded-xl border border-qn-border bg-qn-card text-xs'
      if (!body) return <div className={`${surface} ${row}`}>{header}</div>
      return (
        <LazyDetails className={`group ${surface}`} summary={
          <summary className={`${row} list-none [&::-webkit-details-marker]:hidden`}>
            {header}
            <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
        }>
          <div className="qn-markdown min-w-0 wrap-anywhere border-t border-qn-border px-3 py-2 text-sm">
            <Markdown text={body} streaming={false} />
          </div>
        </LazyDetails>
      )
    }
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
        const Icon = item.status === 'failed' ? CircleX : item.status === 'interrupted' ? Terminal : Check
        return <div className="qn-thinking" role="status">{busy ? <LoadingIcon /> : <Icon size={14} aria-hidden />}{translateMessage(item.summary)}</div>
      }
      // 提交的计划：审批结束后仍能在对话里回看全文。
      if (item.plan) {
        return (
          <LazyDetails className="group qn-tool text-xs" summary={
            <summary className="qn-tool-row list-none [&::-webkit-details-marker]:hidden">
              <ListChecks size={14} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t('提交的计划')}</span>
              <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
          }>
            <div className="qn-tool-body qn-markdown min-w-0 wrap-anywhere"><Markdown text={item.plan} streaming={false} /></div>
            <MessageActions text={item.plan} onQuote={onQuote} />
          </LazyDetails>
        )
      }
      // 其他系统提示：长文本只显示一行摘要，点开看全文（参考 Orca 手机版 notice disclosure）。
      if (item.summary.length > 80 || item.summary.includes('\n')) {
        return (
          <LazyDetails className="group qn-tool text-xs" summary={
            <summary className="qn-tool-row list-none [&::-webkit-details-marker]:hidden">
              <span className="shrink-0 text-2xs">{item.type}</span>
              <span className="min-w-0 flex-1 truncate">{item.summary.split('\n')[0]}</span>
              <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
          }>
            <div className="qn-tool-body whitespace-pre-wrap break-words">{item.summary}</div>
            <MessageActions text={item.summary} onQuote={onQuote} />
          </LazyDetails>
        )
      }
      return (
        <div className="qn-tool qn-tool-open text-xs">
          <div className="mb-1 text-2xs text-qn-muted">{item.type}</div>
          <div className="whitespace-pre-wrap break-words">{item.summary}</div>
          <MessageActions text={item.summary} onQuote={onQuote} />
        </div>
      )
  }
}
