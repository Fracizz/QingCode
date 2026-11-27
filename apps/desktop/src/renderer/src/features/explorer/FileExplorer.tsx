import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { ContextMenu } from 'radix-ui'
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  Eye,
  EyeOff,
  File as FileIcon,
  FileCode2,
  FileJson,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  Image as ImageIcon,
  Pencil,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../../components/primitives'
import { Checkbox, ErrorNote, IconButton, Modal } from '../../components/ui'
import { cn } from '../../lib/cn'
import { downloadProjectFile } from '../workspace/download'
import { openFile } from '../workspace/openers'
import { explorerScopeKey, useExplorer } from './explorerStore'
import {
  baseName,
  createTreeState,
  detectPathStyle,
  isExpanded,
  isSamePath,
  parentPath,
  relativePath,
  validateEntryName,
  visibleRows,
  withDraft,
  type DisplayRow,
  type ExplorerEntryKind,
  type TreeDraft,
} from './treeModel'

const ROW_HEIGHT = 24
const OVERSCAN = 8
const EMPTY_TREE = createTreeState()

type Editing = { draft: TreeDraft; name: string; error: string | null }
type DeleteTarget = { path: string; kind: ExplorerEntryKind }
type MenuTarget = { path: string | null; dir: string; kind: ExplorerEntryKind | 'placeholder' }

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 走下面的 execCommand 兜底。
  }
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'sql', 'html', 'css',
  'scss', 'less', 'vue', 'svelte', 'lua', 'swift',
])
const DATA_EXT = new Set(['json', 'jsonc', 'toml', 'yaml', 'yml', 'xml', 'ini', 'conf', 'lock'])
const TEXT_EXT = new Set(['md', 'mdx', 'txt', 'log', 'csv', 'rtf'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

function entryIcon(name: string, kind: ExplorerEntryKind | 'placeholder', expanded: boolean): ReactNode {
  if (kind === 'placeholder') return null
  if (kind === 'dir') {
    return expanded
      ? <FolderOpen size={14} className="shrink-0 text-amber-300" />
      : <Folder size={14} className="shrink-0 text-amber-300" />
  }
  if (kind === 'symlink') return <FolderSymlink size={14} className="shrink-0 text-qn-brand" />
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (IMAGE_EXT.has(ext)) return <ImageIcon size={14} className="shrink-0 text-violet-300" />
  if (DATA_EXT.has(ext)) return <FileJson size={14} className="shrink-0 text-qn-warn" />
  if (TEXT_EXT.has(ext)) return <FileText size={14} className="shrink-0 text-qn-muted" />
  if (CODE_EXT.has(ext)) return <FileCode2 size={14} className="shrink-0 text-qn-accent" />
  if (ext === '') return <Braces size={14} className="shrink-0 text-qn-muted" />
  return <FileIcon size={14} className="shrink-0 text-qn-muted" />
}

/** 项目文件树：懒加载 + 定高虚拟滚动 + 右键操作；打开文件统一走 openers.openFile。 */
export function FileExplorer({
  targetId,
  root,
  className,
}: {
  targetId: string
  root: string
  className?: string
}) {
  const key = explorerScopeKey(targetId, root)
  const scope = useExplorer((state) => state.scopes[key])
  const actions = useExplorer((state) => state.actions)
  const tree = scope?.tree ?? EMPTY_TREE
  const style = useMemo(() => detectPathStyle(root), [root])
  const baseRows = useMemo(() => visibleRows(tree, root, style), [tree, root, style])

  const [editing, setEditing] = useState<Editing | null>(null)
  const rows = useMemo(
    () => withDraft(baseRows, editing?.draft ?? null, root, style),
    [baseRows, editing?.draft, root, style],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const menuTarget = useRef<MenuTarget>({ path: null, dir: root, kind: 'dir' })
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [recursive, setRecursive] = useState(true)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 320 })
  const containerRef = useRef<HTMLDivElement>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    actions.init(targetId, root)
  }, [actions, targetId, root])

  // 恢复的展开目录、以及 fs.changed 后新展开的目录在这里补齐缓存。
  useEffect(() => {
    if (!scope) return
    for (const dir of tree.expanded) {
      if (!tree.dirs[dir]) void actions.loadDir(targetId, root, dir)
    }
  }, [scope, tree.expanded, tree.dirs, actions, targetId, root])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const measure = () => setViewport((value) => ({ ...value, height: element.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setSelectedIndex((index) => (rows.length === 0 ? 0 : Math.min(index, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const top = selectedIndex * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight
    }
  }, [selectedIndex])

  useEffect(() => {
    if (!editing) return
    const index = rows.findIndex((row) => row.kind === 'draft')
    if (index >= 0) setSelectedIndex(index)
    // 只在新建/重命名开始时定位输入框。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    [],
  )

  const showNotice = (text: string): void => {
    setNotice(text)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 1600)
  }

  const beginCreate = (parent: string, kind: 'file' | 'dir'): void => {
    if (!isSamePath(parent, root, style) && !isExpanded(tree, parent, style)) {
      actions.toggle(targetId, root, parent)
    }
    setEditing({ draft: { mode: 'create', parent, kind }, name: '', error: null })
  }

  const beginRename = (path: string): void => {
    setEditing({ draft: { mode: 'rename', path }, name: baseName(path), error: null })
  }

  const commitEditing = async (): Promise<void> => {
    if (!editing) return
    const current = editing
    const problem = validateEntryName(current.name, style)
    if (problem) {
      setEditing({ ...current, error: problem })
      return
    }
    const error =
      current.draft.mode === 'create'
        ? await actions.createEntry(
            targetId,
            root,
            current.draft.parent,
            current.name,
            current.draft.kind,
          )
        : await actions.renameEntry(targetId, root, current.draft.path, current.name)
    if (error) {
      setEditing((value) => (value ? { ...value, error } : value))
      return
    }
    setEditing(null)
  }

  const activateRow = (row: DisplayRow): void => {
    if (row.kind === 'draft') return
    const node = row.node
    if (node.kind === 'placeholder') {
      void actions.refresh(targetId, root, node.path)
      return
    }
    if (node.kind === 'file') openFile({ targetId, path: node.path })
    else actions.toggle(targetId, root, node.path)
  }

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (editing || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    const row = rows[selectedIndex]
    if (!row) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setSelectedIndex((index) => Math.min(index + 1, rows.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setSelectedIndex((index) => Math.max(0, index - 1))
        break
      case 'ArrowRight':
        event.preventDefault()
        if (row.kind === 'node' && (row.node.kind === 'dir' || row.node.kind === 'symlink')) {
          if (!row.node.expanded) actions.toggle(targetId, root, row.node.path)
          else setSelectedIndex((index) => Math.min(index + 1, rows.length - 1))
        }
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (row.kind !== 'node') break
        if (row.node.expanded) {
          actions.toggle(targetId, root, row.node.path)
          break
        }
        for (let index = selectedIndex - 1; index >= 0; index -= 1) {
          const candidate = rows[index]
          if (candidate?.kind === 'node' && candidate.node.depth < row.node.depth) {
            setSelectedIndex(index)
            break
          }
        }
        break
      case 'Enter':
        event.preventDefault()
        activateRow(row)
        break
      default:
        break
    }
  }

  const onContextMenuCapture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const element = (event.target as HTMLElement).closest?.('[data-tree-path]')
    const path = element?.getAttribute('data-tree-path') ?? null
    const row = path
      ? rows.find((item) => item.kind === 'node' && isSamePath(item.node.path, path, style))
      : undefined
    const kind: ExplorerEntryKind | 'placeholder' =
      row?.kind === 'node' ? row.node.kind : 'placeholder'
    const dir = !path
      ? root
      : kind === 'file'
        ? parentPath(path, style)
        : path
    menuTarget.current = { path, dir, kind }
    setMenuPath(path)
    if (path) {
      const index = rows.findIndex(
        (item) => item.kind === 'node' && isSamePath(item.node.path, path, style),
      )
      if (index >= 0) setSelectedIndex(index)
    }
  }

  const copy = async (text: string): Promise<void> => {
    showNotice((await copyToClipboard(text)) ? '已复制路径' : '复制失败')
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const isDir = deleteTarget.kind !== 'file'
    const error = await actions.deleteEntry(
      targetId,
      root,
      deleteTarget.path,
      isDir && recursive,
    )
    if (error) {
      setDeleteError(error)
      return
    }
    setDeleteTarget(null)
    setDeleteError(null)
    showNotice('已删除')
  }

  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
  )
  const slice = rows.slice(start, end)

  const renderRow = (row: DisplayRow, index: number): ReactNode => {
    const selected = index === selectedIndex
    const position = {
      position: 'absolute' as const,
      top: index * ROW_HEIGHT,
      height: ROW_HEIGHT,
      left: 0,
      right: 0,
    }
    if (row.kind === 'draft') {
      return (
        <div
          key={row.key}
          style={{ ...position, paddingLeft: 8 + row.depth * 14 }}
          className="flex items-center gap-1 pr-2"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            autoFocus
            className="qn-input h-[20px] min-w-0 flex-1 px-1.5 py-0 text-ui-sm"
            value={editing?.name ?? ''}
            placeholder={row.draft.mode === 'create' ? (row.draft.kind === 'file' ? '新文件名' : '新文件夹名') : '新名称'}
            onChange={(event) =>
              setEditing((value) => (value ? { ...value, name: event.target.value, error: null } : value))
            }
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void commitEditing()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(null)
              }
            }}
          />
          <button
            type="button"
            aria-label="确认"
            className="shrink-0 rounded-md p-0.5 text-qn-ok hover:bg-qn-hover"
            onClick={() => void commitEditing()}
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            aria-label="取消"
            className="shrink-0 rounded-md p-0.5 text-qn-muted hover:bg-qn-hover"
            onClick={() => setEditing(null)}
          >
            <X size={13} />
          </button>
          {editing?.error && (
            <span className="truncate text-ui-xs text-qn-danger">{editing.error}</span>
          )}
        </div>
      )
    }

    const node = row.node
    const expandable = node.kind === 'dir' || node.kind === 'symlink'
    return (
      <div
        key={row.key}
        data-tree-path={node.path}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? node.expanded : undefined}
        style={{ ...position, paddingLeft: 6 + node.depth * 14 }}
        title={node.kind === 'placeholder' ? undefined : node.path}
        className={cn(
          'flex cursor-default select-none items-center gap-1 pr-2 text-ui-sm outline-none',
          selected ? 'bg-qn-accent/20' : 'hover:bg-qn-fg/5',
          node.kind === 'placeholder' && 'text-qn-muted',
        )}
        onClick={() => {
          setSelectedIndex(index)
          activateRow(row)
        }}
      >
        {expandable ? (
          <button
            type="button"
            aria-label={node.expanded ? '折叠' : '展开'}
            className="flex h-4 w-3 shrink-0 items-center justify-center rounded-sm text-qn-muted hover:text-qn-text"
            onClick={(event) => {
              event.stopPropagation()
              setSelectedIndex(index)
              actions.toggle(targetId, root, node.path)
            }}
          >
            {node.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {entryIcon(node.name, node.kind, node.expanded)}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.kind === 'symlink' && <span className="shrink-0 text-ui-2xs text-qn-dim">链接</span>}
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col bg-qn-sidebar text-qn-text', className)}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-qn-border px-2 py-1.5">
        <IconButton label="刷新" onClick={() => void actions.refresh(targetId, root)}>
          <RotateCw size={14} />
        </IconButton>
        <IconButton label="折叠全部" onClick={() => actions.collapse(targetId, root)}>
          <ChevronsDownUp size={14} />
        </IconButton>
        <IconButton
          label={tree.showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
          onClick={() => actions.setHidden(targetId, root, !tree.showHidden)}
        >
          {tree.showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <span className="min-w-0 flex-1" />
        {notice && <span className="truncate text-ui-xs text-qn-muted">{notice}</span>}
      </div>
      <div className="truncate border-b border-qn-border px-3 py-1 font-mono text-ui-xs text-qn-dim" title={root}>
        {root}
      </div>
      {scope?.error && (
        <div className="px-2 pt-2">
          <ErrorNote message={scope.error} onClose={() => actions.clearError(targetId, root)} />
        </div>
      )}

      <ContextMenu.Root onOpenChange={(open) => { if (!open) setMenuPath(null) }}>
        <ContextMenu.Trigger asChild>
          <div
            ref={containerRef}
            tabIndex={0}
            role="tree"
            aria-label="文件树"
            onScroll={(event) =>
              setViewport((value) => ({ ...value, top: event.currentTarget.scrollTop }))
            }
            onKeyDown={onTreeKeyDown}
            onContextMenuCapture={onContextMenuCapture}
            className="qn-scroll relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-accent"
          >
            <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
              {slice.map((row, offset) => renderRow(row, start + offset))}
            </div>
          </div>
        </ContextMenu.Trigger>
        <ContextMenuContent>
          <ContextMenuItem
            icon={<FilePlus2 size={14} />}
            onSelect={() => beginCreate(menuTarget.current.dir, 'file')}
          >
            新建文件
          </ContextMenuItem>
          <ContextMenuItem
            icon={<FolderPlus size={14} />}
            onSelect={() => beginCreate(menuTarget.current.dir, 'dir')}
          >
            新建文件夹
          </ContextMenuItem>
          <ContextMenuSeparator />
          {targetId !== 'local' && menuPath && menuTarget.current.kind === 'file' && (
            <ContextMenuItem icon={<Download size={14} />} onSelect={() => void downloadProjectFile(targetId, root, menuPath)}>
              下载到本机
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon={<Pencil size={14} />}
            disabled={!menuPath}
            onSelect={() => {
              const path = menuTarget.current.path
              if (path) beginRename(path)
            }}
          >
            重命名
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Trash2 size={14} />}
            danger
            disabled={!menuPath}
            onSelect={() => {
              const target = menuTarget.current
              if (target.path && target.kind !== 'placeholder') {
                setDeleteTarget({ path: target.path, kind: target.kind })
                setRecursive(true)
                setDeleteError(null)
              }
            }}
          >
            删除
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Copy size={14} />}
            disabled={!menuPath}
            onSelect={() => {
              const path = menuTarget.current.path
              if (path) void copy(path)
            }}
          >
            复制路径
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Copy size={14} />}
            disabled={!menuPath}
            onSelect={() => {
              const path = menuTarget.current.path
              if (path) void copy(relativePath(root, path, style))
            }}
          >
            复制相对路径
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu.Root>

      {deleteTarget && (
        <Modal
          title={deleteTarget.kind === 'file' ? '删除文件' : '删除文件夹'}
          description={deleteTarget.path}
          onClose={() => setDeleteTarget(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button className="qn-button-subtle" type="button" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                className="qn-button bg-qn-danger hover:bg-qn-danger"
                type="button"
                onClick={() => void confirmDelete()}
              >
                删除
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <p className="leading-6">
              确定删除「{baseName(deleteTarget.path)}」吗？此操作不可撤销。
            </p>
            {deleteTarget.kind !== 'file' && (
              <>
                <p className="rounded-lg border border-qn-warn/30 bg-qn-warn/10 px-3 py-2 leading-6 text-qn-warn">
                  这是目录。勾选下面的选项将使用 recursive:true 连同其中所有内容一起删除；
                  不勾选且目录非空时服务端会拒绝删除。
                </p>
                <Checkbox checked={recursive} onChange={setRecursive}>
                  连同目录内所有内容一起删除
                </Checkbox>
              </>
            )}
            <ErrorNote message={deleteError} onClose={() => setDeleteError(null)} />
          </div>
        </Modal>
      )}
    </div>
  )
}
