import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Code,
  Copy,
  Eye,
  FileDiff,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  PanelRightClose,
  RotateCw,
  X,
} from 'lucide-react'
import { ErrorNote, IconButton, Spinner } from '../../components/ui'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import { openFile } from '../workspace/openers'
import { CodeView } from './CodeView'
import { DiffView } from './DiffView'
import { BinaryNotice, ImageView } from './ImageView'
import { basename, dirname, fileKind } from './fileLinks'
import { createMarkdownLink, qnUrlTransform } from './integrations'
import { useFiles } from './filesStore'
import type { Tab } from './filesModel'

function MarkdownPreview({ content, targetId, cwd }: { content: string; targetId: string; cwd: string }) {
  const link = useMemo(() => createMarkdownLink(() => ({ targetId, cwd })), [targetId, cwd])
  const components = useMemo<Components>(() => ({ a: link }), [link])
  return (
    <div className="qn-scroll qn-markdown min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-6 text-qn-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={qnUrlTransform} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function TabBody({
  tab,
  onRefresh,
  onLoadMore,
  onOpenFile,
}: {
  tab: Tab
  onRefresh: () => void
  onLoadMore: () => void
  onOpenFile: () => void
}) {
  if (tab.kind === 'diff') {
    return (
      <DiffView
        diff={tab.diff}
        status={tab.status}
        path={tab.path}
        error={tab.error}
        errorCode={tab.errorCode}
        notice={tab.notice}
        truncated={tab.diffTruncated}
        onRetry={onRefresh}
        onOpenFile={onOpenFile}
      />
    )
  }
  const kind = fileKind(tab.path)
  let body
  if (tab.status === 'loading' && !tab.content) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner label="读取文件…" />
      </div>
    )
  } else if (tab.binary) {
    body = <BinaryNotice path={tab.path} />
  } else if (kind === 'image') {
    body = tab.truncated ? (
      <BinaryNotice path={tab.path} message="图片过大，仅能读取前 10 MiB" />
    ) : (
      <ImageView content={tab.content} path={tab.path} />
    )
  } else if (kind === 'markdown' && tab.view === 'preview') {
    body = <MarkdownPreview content={tab.content} targetId={tab.targetId} cwd={tab.cwd ?? dirname(tab.path)} />
  } else {
    body = (
      <CodeView
        content={tab.content}
        path={tab.path}
        line={tab.line}
        column={tab.column}
        truncated={tab.truncated}
        loadedBytes={tab.loadedBytes}
        busy={tab.busy}
        onLoadMore={onLoadMore}
      />
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab.status === 'error' && (
        <div className="shrink-0 p-2">
          <ErrorNote message={tab.error ?? '读取文件失败'} onRetry={onRefresh} />
        </div>
      )}
      {body}
    </div>
  )
}

/** 文件查看面板：标签栏 + 工具条 + 内容区；由总管放进布局（open=false 时不占位）。 */
export function FilePane({ className }: { className?: string }) {
  const { tabs, activeId, open, setOpen, activate, close, closeAll, setView, refresh, loadMore } = useFiles()
  if (!open) return null
  const active = tabs.find((tab) => tab.id === activeId) ?? null
  const markdown = active?.kind === 'file' && fileKind(active.path) === 'markdown'

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-qn-bg', className)}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-qn-border px-1.5">
        <div className="qn-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeId}
              tabIndex={0}
              title={tab.path}
              onClick={() => activate(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) close(tab.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activate(tab.id)
                }
              }}
              className={cn(
                'group/tab flex h-7 min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                tab.id === activeId ? 'bg-qn-active text-qn-text' : 'text-qn-muted hover:bg-qn-hover',
              )}
            >
              {tab.busy ? (
                <LoaderCircle size={12} className="shrink-0 animate-spin text-qn-brand" />
              ) : tab.kind === 'diff' ? (
                <FileDiff size={12} className="shrink-0 text-qn-dim" />
              ) : fileKind(tab.path) === 'image' ? (
                <ImageIcon size={12} className="shrink-0 text-qn-dim" />
              ) : (
                <FileText size={12} className="shrink-0 text-qn-dim" />
              )}
              <span className="truncate">{basename(tab.path) || tab.path}</span>
              <span className="truncate text-[11px] text-qn-dim">{basename(dirname(tab.path))}</span>
              <button
                type="button"
                aria-label={`关闭 ${basename(tab.path)}`}
                className="ml-auto shrink-0 rounded-md p-0.5 text-qn-dim hover:bg-qn-hover hover:text-qn-text"
                onClick={(event) => {
                  event.stopPropagation()
                  close(tab.id)
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-qn-border pl-1">
          {active && (
            <>
              <IconButton label="复制完整路径" size="sm" onClick={() => void copyText(active.path)}>
                <Copy size={13} />
              </IconButton>
              <IconButton label="刷新" size="sm" onClick={() => refresh(active.id)}>
                <RotateCw size={13} />
              </IconButton>
              {markdown && (
                <IconButton
                  label={active.view === 'preview' ? '查看源码' : 'Markdown 预览'}
                  size="sm"
                  onClick={() => setView(active.id, active.view === 'preview' ? 'source' : 'preview')}
                >
                  {active.view === 'preview' ? <Code size={13} /> : <Eye size={13} />}
                </IconButton>
              )}
              <IconButton label="关闭全部标签" size="sm" onClick={closeAll}>
                <X size={13} />
              </IconButton>
            </>
          )}
          <IconButton label="收起文件查看面板" size="sm" onClick={() => setOpen(false)}>
            <PanelRightClose size={13} />
          </IconButton>
        </div>
      </div>

      {active ? (
        <TabBody
          tab={active}
          onRefresh={() => refresh(active.id)}
          onLoadMore={() => loadMore(active.id)}
          onOpenFile={() => openFile({ targetId: active.targetId, path: active.path })}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <FileText size={26} className="text-qn-dim" />
          <div className="text-[13px] text-qn-muted">点击对话里的文件路径或 Markdown 链接，在这里查看</div>
          <div className="text-[12px] text-qn-dim">支持语法高亮、跳转行号、图片与 Markdown 预览、diff 对比</div>
        </div>
      )}
    </div>
  )
}
