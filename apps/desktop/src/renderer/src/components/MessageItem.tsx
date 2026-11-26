import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, Brain, FileDiff, FileText, Terminal, User } from 'lucide-react'
import type { ItemView } from '@qn/codex-client'
import { diffRows, lineCount, tailLines } from '../lib/diff'
import { MessageActions } from './MessageActions'
import { Badge } from './ui'

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-qn-accent underline">
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="qn-pre">{children}</pre>,
  code: ({ className, children }) => (
    <code className={`rounded bg-black/40 px-1 font-mono text-[12px] ${className ?? ''}`}>
      {children}
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

const statusTone = (status: string): 'muted' | 'accent' | 'danger' | 'ok' => {
  if (/fail|error|denied|declined/i.test(status)) return 'danger'
  if (/completed|success/i.test(status)) return 'ok'
  if (/progress|running|started/i.test(status)) return 'accent'
  return 'muted'
}

function DiffBlock({ text }: { text: string }) {
  const rows = diffRows(text)
  if (rows.length === 0) return null
  const truncated = lineCount(text) > rows.length
  return (
    <div>
      {truncated && <div className="px-2 py-1 text-[10px] text-qn-muted">仅显示末尾 {rows.length} 行</div>}
      <pre className="qn-scroll max-h-64 overflow-auto rounded border border-qn-border bg-black/30 font-mono text-[11px] leading-5">
        {rows.map((row, index) => (
          <div
            key={index}
            className={`whitespace-pre px-2 ${
              row.kind === 'add'
                ? 'bg-emerald-500/10 text-emerald-300'
                : row.kind === 'remove'
                  ? 'bg-red-500/10 text-red-300'
                  : row.kind === 'meta'
                    ? 'text-qn-muted'
                    : ''
            }`}
          >
            {row.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

function CommandItem({ item }: { item: Extract<ItemView, { kind: 'command' }> }) {
  const output = tailLines(item.output, 200)
  const truncated = lineCount(item.output) > 200
  return (
    <div className="rounded border border-qn-border bg-black/20 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Terminal size={13} className="text-amber-300" />
        <span className="font-mono text-[12px]">$ {item.command || '（命令）'}</span>
        <Badge tone={statusTone(item.status)}>{item.status}</Badge>
        {item.exitCode !== null && item.exitCode !== undefined && (
          <Badge tone={item.exitCode === 0 ? 'ok' : 'danger'}>退出码 {item.exitCode}</Badge>
        )}
      </div>
      {item.cwd && <div className="mt-1 font-mono text-[10px] text-qn-muted">cwd: {item.cwd}</div>}
      {output && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-qn-muted">
            输出{truncated ? '（末尾 200 行）' : ''}
          </summary>
          <pre className="qn-scroll mt-1 max-h-64 overflow-auto whitespace-pre rounded border border-qn-border bg-black/40 p-2 font-mono text-[11px] leading-5">
            {output}
          </pre>
        </details>
      )}
    </div>
  )
}

function FileChangeItem({ item }: { item: Extract<ItemView, { kind: 'fileChange' }> }) {
  return (
    <div className="rounded border border-qn-border bg-black/20 p-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <FileDiff size={13} className="text-qn-accent" />
        <span>文件改动</span>
        <Badge tone={statusTone(item.status)}>{item.status}</Badge>
      </div>
      {item.changes.length === 0 && <div className="text-qn-muted">等待改动内容…</div>}
      <div className="space-y-2">
        {item.changes.map((change, index) => (
          <div key={`${change.path}-${change.kind}-${index}`}>
            <div className="flex items-center gap-2 py-1">
              <span className="min-w-0 truncate font-mono text-[11px]">{change.path}</span>
              <Badge>{change.kind}</Badge>
            </div>
            {typeof change.diff === 'string' && change.diff !== '' && <DiffBlock text={change.diff} />}
          </div>
        ))}
      </div>
    </div>
  )
}

export function MessageItem({
  item,
  onFork,
}: {
  item: ItemView
  onFork?: (markdown: string) => void
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg border border-qn-accent/30 bg-qn-accent/10 px-3 py-2">
            <div className="mb-1 flex items-center justify-end gap-1 text-[11px] text-qn-muted">
              <User size={12} /> 你
            </div>
            <div className="whitespace-pre-wrap break-words text-sm">{item.text}</div>
          </div>
        </div>
      )
    case 'agent':
      return (
        <div className="rounded-lg border border-qn-border bg-qn-panel px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-qn-muted">
            <Bot size={12} /> Agent
            {item.streaming && <Badge tone="accent">生成中</Badge>}
          </div>
          <div className="qn-markdown break-words text-sm leading-6">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {item.text}
            </ReactMarkdown>
            {item.streaming && (
              <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-qn-accent align-middle" />
            )}
          </div>
          {!item.streaming && (
            <MessageActions
              markdown={item.text}
              onFork={onFork ? () => onFork(item.text) : undefined}
            />
          )}
        </div>
      )
    case 'reasoning':
      return (
        <details className="rounded border border-qn-border bg-black/10 px-3 py-2 text-xs">
          <summary className="flex cursor-pointer items-center gap-1.5 text-qn-muted">
            <Brain size={12} /> 推理摘要
            {item.streaming && <Badge tone="accent">进行中</Badge>}
          </summary>
          <div className="mt-2 whitespace-pre-wrap break-words leading-5 text-qn-text/90">
            {item.summary || '（暂无摘要）'}
          </div>
        </details>
      )
    case 'command':
      return <CommandItem item={item} />
    case 'fileChange':
      return <FileChangeItem item={item} />
    case 'other':
      return (
        <div className="rounded border border-qn-border bg-black/10 px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-1.5 text-qn-muted">
            <FileText size={12} /> {item.type}
          </div>
          <div className="whitespace-pre-wrap break-words">{item.summary}</div>
        </div>
      )
  }
}
