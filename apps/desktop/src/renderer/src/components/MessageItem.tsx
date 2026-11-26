import { Children, isValidElement, memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Brain, ChevronRight, FileDiff, FileText, ImageIcon, ListChecks, LoaderCircle, Terminal, Wand2 } from 'lucide-react'
import type { ItemView } from '@qn/codex-client'
import { basename, splitUserText } from '../lib/attachments'
import { diffRows, lineCount, tailLines } from '../lib/diff'
import { langFromClassName } from '../lib/highlight'
import { isGroupRunning, summarizeTools } from '../lib/turnGroups'
import { CodeBlock } from './CodeBlock'
import { MessageActions } from './MessageActions'
import { Badge } from './ui'

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
}

function markdownComponents(streaming: boolean): Components {
  return {
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-qn-accent underline-offset-2 hover:underline">
        {children}
      </a>
    ),
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
    code: ({ className, children }) => (
      <code className={`rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.86em] ${className ?? ''}`}>{children}</code>
    ),
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
            </div>
            {typeof change.diff === 'string' && change.diff !== '' && <DiffBlock text={change.diff} />}
          </div>
        ))}
      </div>
    </ToolRow>
  )
}

function AgentMessage({ text, streaming, onFork }: { text: string; streaming: boolean; onFork?: (markdown: string) => void }) {
  const components = useMemo(() => markdownComponents(streaming), [streaming])
  return (
    <div className="group/msg">
      <div className="qn-markdown break-words text-[14px] leading-[1.7] text-qn-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-qn-brand align-middle" />}
      </div>
      {!streaming && <MessageActions markdown={text} onFork={onFork ? () => onFork(text) : undefined} />}
    </div>
  )
}

export const MessageItem = memo(function MessageItem({
  item,
  onFork,
}: {
  item: ItemView
  onFork?: (markdown: string) => void
}) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />
    case 'agent':
      return <AgentMessage text={item.text} streaming={item.streaming === true} onFork={onFork} />
    case 'reasoning':
      return (
        <ToolRow
          icon={<Brain size={14} className={item.streaming ? 'animate-pulse text-qn-brand' : ''} />}
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

/** 连续工具步骤的折叠组：一行摘要，展开后逐条显示；仍在运行时默认展开，方便看进度。 */
export const ToolGroup = memo(function ToolGroup({ items }: { items: ItemView[] }) {
  const running = isGroupRunning(items)
  return (
    <details className="group/steps text-[13px]" open={running || undefined}>
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

/** 用户消息：右侧灰色气泡；图片缩略图与附件/技能标签放在气泡上方。 */
function UserMessage({ item }: { item: Extract<ItemView, { kind: 'user' }> }) {
  const parsed = splitUserText(item.text)
  const files = [...(item.files ?? []), ...parsed.files.filter((path) => !item.files?.includes(path))]
  const skills = item.skills?.length ? item.skills : parsed.skill ? [parsed.skill] : []
  // data / http 图片能直接显示；目标机本地路径只显示文件名。
  const images = item.images ?? []
  const visible = images.filter((src) => src.startsWith('data:image/'))
  const named = images.filter((src) => !src.startsWith('data:image/'))
  return (
    <div className="flex flex-col items-end gap-1.5">
      {visible.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {visible.map((src, index) => (
            <img
              key={index}
              src={src}
              alt={'图片 ' + (index + 1)}
              className="max-h-48 max-w-[16rem] rounded-xl border border-qn-border object-contain"
            />
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
      {parsed.text.trim() && (
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-qn-elevated px-4 py-2.5 text-[14px] leading-6 text-qn-text">
          {parsed.text}
        </div>
      )}
    </div>
  )
}

