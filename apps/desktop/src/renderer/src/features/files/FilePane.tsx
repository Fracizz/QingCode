import { useRef, type RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import {
  Code,
  Copy,
  Eye,
  Download,
  FileDiff,
  FileText,
  Image as ImageIcon,
  LockKeyhole,
  PanelRightClose,
  RotateCw,
  Save,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import { LoadingIcon } from '../../components/LoadingIcon'
import { StatusDot } from '../../components/StatusDot'
import { ErrorNote, IconButton, Spinner } from '../../components/ui'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import { isWithinPath } from '../explorer/treeModel'
import { downloadProjectFile } from '../workspace/download'
import { openFile } from '../workspace/openers'
import { CodeEditor } from './editor/CodeEditor'
import { DiffView } from './DiffView'
import { BinaryNotice, ImageView } from './ImageView'
import { basename, dirname, fileKind } from './fileLinks'
import { MarkdownPreview } from './MarkdownPreview'
import { useFiles } from './filesStore'
import { readOnlyLabel, readOnlyReason } from './editModel'
import type { Tab } from './filesModel'
import { FileDialogs } from './dialogs'

function TabBody({
  tab,
  editorRef,
  onRefresh,
  onLoadMore,
  onOpenFile,
}: {
  tab: Tab
  editorRef: RefObject<EditorView | null>
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
      <ImageView key={tab.id} content={tab.content} path={tab.path} />
    )
  } else if (kind === 'markdown' && tab.view === 'preview') {
    body = <>
      <MarkdownPreview content={tab.content} targetId={tab.targetId} cwd={tab.cwd ?? dirname(tab.path)} />
      {tab.truncated && <button type="button" className="qn-button-subtle" disabled={tab.busy} onClick={onLoadMore}>
        {tab.busy ? '加载中…' : '加载更多'}
      </button>}
    </>
  } else {
    body = (
      <CodeEditor
        viewRef={editorRef}
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
type ProjectScope = { targetId: string; cwd: string }

export function FilePane({ className, scope, primary = false }: {
  className?: string
  scope?: ProjectScope
  primary?: boolean
}) {
  const { tabs: allTabs, activeId, open, setOpen, activate, setView, refresh, loadMore, requestClose, requestCloseAll, save } =
    useFiles()
  const editorRef = useRef<EditorView>(null)
  if (!open && !primary) return null
  const inProject = (tab: Tab) => scope && tab.targetId === scope.targetId && isWithinPath(tab.path, scope.cwd)
  const tabs = primary ? allTabs.filter(inProject) : allTabs
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null
  const markdown = active?.kind === 'file' && fileKind(active.path) === 'markdown'
  const reason = active ? readOnlyReason(active) : null
  const sourceVisible = active?.kind === 'file' && active.status === 'ready' && !active.binary &&
    fileKind(active.path) !== 'image' && !(markdown && active.view === 'preview')

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-qn-bg', className)}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-qn-border px-1.5">
        <div className="qn-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === active?.id}
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
                'group/tab flex h-7 min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                tab.id === active?.id ? 'bg-qn-active text-qn-text' : 'text-qn-muted hover:bg-qn-hover',
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
              {tab.dirty && <StatusDot className="bg-qn-warn" title="未保存" />}
              {tab.diskChanged && (
                <span className="shrink-0" title="磁盘已更改" aria-label="磁盘已更改">
                  <TriangleAlert size={11} className="text-qn-danger" />
                </span>
              )}
              <span className="truncate">{basename(tab.path) || tab.path}</span>
              <span className="truncate text-[11px] text-qn-dim">{basename(dirname(tab.path))}</span>
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
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1 text-[11px] text-qn-muted"
                  title={`只读 · ${readOnlyLabel(reason)}`}
                >
                  <LockKeyhole size={12} />
                </span>
              )}
              {scope && inProject(active) && active.kind === 'file' && active.targetId !== 'local' && (
                <IconButton label="下载远程磁盘文件到本机" size="sm"
                  onClick={() => void downloadProjectFile(active.targetId, scope.cwd, active.path)}>
                  <Download size={13} />
                </IconButton>
              )}
              {sourceVisible && (
                <IconButton
                  label="在文件中查找（Ctrl+F）"
                  size="sm"
                  onClick={() => {
                    const view = editorRef.current
                    if (view) openSearchPanel(view)
                  }}
                >
                  <Search size={13} />
                </IconButton>
              )}
              <IconButton label="复制完整路径" size="sm" onClick={() => void copyText(active.path)}>
                <Copy size={13} />
              </IconButton>
              <IconButton label="刷新（有未保存改动时会先确认）" size="sm" onClick={() => refresh(active.id)}>
                <RotateCw size={13} />
              </IconButton>
              {active.kind === 'file' && !reason && active.dirty && (
                <IconButton
                  label="保存（Ctrl+S）"
                  size="sm"
                  disabled={active.saving}
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
              <IconButton label="关闭全部标签" size="sm" onClick={() => requestCloseAll(tabs.map((tab) => tab.id))}>
                <X size={13} />
              </IconButton>
            </>
          )}
          {!primary && <IconButton label="收起文件查看面板" size="sm" onClick={() => setOpen(false)}>
            <PanelRightClose size={13} />
          </IconButton>}
        </div>
      </div>

      {active ? (
        <TabBody
          editorRef={editorRef}
          tab={active}
          onRefresh={() => refresh(active.id)}
          onLoadMore={() => loadMore(active.id)}
          onOpenFile={() => openFile({ targetId: active.targetId, path: active.path })}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <FileText size={26} className="text-qn-dim" />
          <div className="text-[13px] text-qn-muted">{primary ? '选择文件开始查看' : '点击对话里的文件路径或 Markdown 链接，在这里查看与编辑'}</div>
          <div className="text-[12px] text-qn-dim">Ctrl+S 保存、Ctrl+F 搜索、Ctrl+H 替换、Ctrl+G 跳转行</div>
        </div>
      )}
      <FileDialogs />
    </div>
  )
}
