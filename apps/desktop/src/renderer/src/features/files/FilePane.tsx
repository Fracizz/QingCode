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
  LockKeyhole,
  PanelRightClose,
  RotateCw,
  Save,
  TriangleAlert,
  X,
} from 'lucide-react'
import { LoadingIcon } from '../../components/LoadingIcon'
import { ErrorNote, IconButton, Spinner } from '../../components/ui'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import { openFile } from '../workspace/openers'
import { CodeEditor } from './editor/CodeEditor'
import { DiffView } from './DiffView'
import { BinaryNotice, ImageView } from './ImageView'
import { basename, dirname, fileKind } from './fileLinks'
import { createMarkdownLink, qnUrlTransform } from './integrations'
import { useFiles } from './filesStore'
import { readOnlyLabel, readOnlyReason } from './editModel'
import type { Tab } from './filesModel'
import { FileDialogs } from './dialogs'

function MarkdownPreview({ content, targetId, cwd }: { content: string; targetId: string; cwd: string }) {
  const link = useMemo(() => createMarkdownLink(() => ({ targetId, cwd })), [targetId, cwd])
  const components = useMemo<Components>(() => ({ a: link }), [link])
  return (
    <div className="qn-scroll qn-markdown min-h-0 flex-1 overflow-auto px-4 py-3 text-[length:var(--qn-editor-font-size,13px)] leading-[1.8] text-qn-text">
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
  const edit = useFiles((state) => state.edit)
  const save = useFiles((state) => state.save)

  if (tab.kind === 'diff') {
    return (
      <DiffView
        diff={tab.diff}
        status={tab.status}
        path={tab.path}
        targetId={tab.targetId}
        cwd={tab.cwd ?? dirname(tab.path)}
        mode={tab.mode}
        commit={tab.commit}
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
      <CodeEditor
        tab={tab}
        onChange={(text) => edit(tab.id, text)}
        onSave={() => void save(tab.id)}
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
      {tab.saveError && (
        <div className="shrink-0 p-2 pt-0">
          <ErrorNote message={tab.saveError} />
        </div>
      )}
      {body}
    </div>
  )
}

/** 文件查看/编辑面板：标签栏 + 工具条 + 内容区；由总管放进布局（open=false 时不占位）。 */
export function FilePane({ className }: { className?: string }) {
  const { tabs, activeId, open, setOpen, activate, setView, refresh, loadMore, requestClose, requestCloseAll, save } =
    useFiles()
  if (!open) return null
  const active = tabs.find((tab) => tab.id === activeId) ?? null
  const markdown = active?.kind === 'file' && fileKind(active.path) === 'markdown'
  const reason = active ? readOnlyReason(active) : null
  const editable = active?.kind === 'file' && reason === null && !(markdown && active.view === 'preview')

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
                if (event.button === 1) requestClose(tab.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activate(tab.id)
                }
              }}
              className={cn(
                'group/tab flex h-7 min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-ui-sm outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                tab.id === activeId ? 'bg-qn-active text-qn-text' : 'text-qn-muted hover:bg-qn-hover',
              )}
            >
              {tab.busy || tab.saving ? (
                <LoadingIcon size={12} className="text-qn-brand" />
              ) : tab.kind === 'diff' ? (
                <FileDiff size={12} className="shrink-0 text-qn-dim" />
              ) : fileKind(tab.path) === 'image' ? (
                <ImageIcon size={12} className="shrink-0 text-qn-dim" />
              ) : (
                <FileText size={12} className="shrink-0 text-qn-dim" />
              )}
              {tab.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-qn-warn" title="未保存" />}
              {tab.diskChanged && (
                <span className="shrink-0" title="磁盘已更改" aria-label="磁盘已更改">
                  <TriangleAlert size={11} className="text-qn-danger" />
                </span>
              )}
              <span className="truncate">{basename(tab.path) || tab.path}</span>
              <span className="truncate text-ui-xs text-qn-dim">{basename(dirname(tab.path))}</span>
              <IconButton
                label={`关闭 ${basename(tab.path)}`}
                size="sm"
                tooltip={false}
                className="ml-auto size-4 text-qn-dim"
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  requestClose(tab.id)
                }}
              >
                <X size={11} />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-qn-border pl-1">
          {active && (
            <>
              {reason && (
                <span
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1 text-ui-xs text-qn-muted"
                  title={`只读 · ${readOnlyLabel(reason)}`}
                >
                  <LockKeyhole size={12} />
                </span>
              )}
              <IconButton label="复制完整路径" size="sm" onClick={() => void copyText(active.path)}>
                <Copy size={13} />
              </IconButton>
              <IconButton label="刷新（有未保存改动时会先确认）" size="sm" onClick={() => refresh(active.id)}>
                <RotateCw size={13} />
              </IconButton>
              {editable && (
                <IconButton
                  label="保存（Ctrl+S）"
                  size="sm"
                  disabled={!active.dirty || active.saving}
                  onClick={() => void save(active.id)}
                >
                  <Save size={13} />
                </IconButton>
              )}
              {markdown && (
                <IconButton
                  label={active.view === 'preview' ? '查看源码' : 'Markdown 预览'}
                  size="sm"
                  onClick={() => setView(active.id, active.view === 'preview' ? 'source' : 'preview')}
                >
                  {active.view === 'preview' ? <Code size={13} /> : <Eye size={13} />}
                </IconButton>
              )}
              <IconButton label="关闭全部标签" size="sm" onClick={requestCloseAll}>
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
          <div className="text-ui text-qn-muted">点击对话里的文件路径或 Markdown 链接，在这里查看与编辑</div>
          <div className="text-ui-sm text-qn-dim">Ctrl+S 保存、Ctrl+F 搜索、Ctrl+H 替换、Ctrl+G 跳转行</div>
        </div>
      )}
      <FileDialogs />
    </div>
  )
}
