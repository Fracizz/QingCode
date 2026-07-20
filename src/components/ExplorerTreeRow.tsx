import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type { RowComponentProps } from 'react-window'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw,
} from 'lucide-react'
import type { FileNode } from '../store/projectStore'
import { gitStatusColorClass, gitStatusGlyph } from '../lib/gitStatus'
import { COPY_RELATIVE_PATH_SHORTCUT, shortcutMatchesEvent } from '../lib/shortcuts'
import { pathSetHas, pathsEqual } from '../utils/fileReferences'
import type { VisibleTreeRow } from '../utils/fileTreeView'
import InlineCreateRow from './InlineCreateRow'
import Tooltip from './Tooltip'

type ExplorerTreeContextTarget = { kind: 'node'; node: FileNode }

type ExplorerTreeRowProps = {
  rows: VisibleTreeRow[]
  expandedPaths: Set<string>
  loadingPaths: Set<string>
  selectedPaths: Set<string>
  cutPaths: Set<string>
  dragOverPath: string | null
  draggingPaths: Set<string>
  gitStatusFor: (path: string, isDir: boolean) => string | null
  onOpenContextMenu: (event: ReactMouseEvent, target: ExplorerTreeContextTarget) => void
  onCopyPath: (path: string) => void
  onCopyRelativePath: (path: string) => void
  onCopyAsReference: (path: string) => void
  onSelectNode: (node: FileNode, event: ReactMouseEvent) => void
  onOpenNode: (node: FileNode) => void
  onToggleFolder: (node: FileNode) => void
  onCommitCreate: (name: string) => void
  onCancelCreate: () => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
  onPointerDownNode: (event: ReactPointerEvent, node: FileNode) => void
}

export default function ExplorerTreeRow({
  ariaAttributes,
  index,
  style,
  rows,
  expandedPaths,
  loadingPaths,
  selectedPaths,
  cutPaths,
  dragOverPath,
  draggingPaths,
  gitStatusFor,
  onOpenContextMenu,
  onCopyPath,
  onCopyRelativePath,
  onCopyAsReference,
  onSelectNode,
  onOpenNode,
  onToggleFolder,
  onCommitCreate,
  onCancelCreate,
  onCommitRename,
  onCancelRename,
  onPointerDownNode,
}: RowComponentProps<ExplorerTreeRowProps>) {
  const row = rows[index]
  if (row.kind === 'create') {
    return (
      <div style={style} {...ariaAttributes}>
        <InlineCreateRow
          directory={row.directory}
          depth={row.depth}
          onSubmit={onCommitCreate}
          onCancel={onCancelCreate}
        />
      </div>
    )
  }
  if (row.kind === 'rename') {
    return (
      <div style={style} {...ariaAttributes}>
        <InlineCreateRow
          directory={row.node.is_dir}
          depth={row.depth}
          initialName={row.node.name}
          onSubmit={onCommitRename}
          onCancel={onCancelRename}
        />
      </div>
    )
  }

  const { node, depth } = row
  const expanded = node.is_dir && pathSetHas(expandedPaths, node.path)
  const isSelected = pathSetHas(selectedPaths, node.path)
  const isCut = pathSetHas(cutPaths, node.path)
  const isDragging = pathSetHas(draggingPaths, node.path)
  const isDropTarget = dragOverPath != null && pathsEqual(node.path, dragOverPath)
  const rowStyle: CSSProperties = {
    ...style,
    paddingLeft: depth * 12 + 8,
    ...(isDropTarget
      ? {
          boxShadow: 'inset 3px 0 0 var(--color-accent)',
          background: 'color-mix(in srgb, var(--color-accent) 28%, transparent)',
        }
      : {}),
  }
  const gitStatus = gitStatusFor(node.path, !!node.is_dir)
  const gitGlyph = gitStatusGlyph(gitStatus)
  const gitColor = gitStatusColorClass(gitStatus)

  return (
    <div
      {...ariaAttributes}
      tabIndex={-1}
      data-explorer-drop={node.path}
      data-explorer-isdir={node.is_dir ? '1' : '0'}
      aria-expanded={node.is_dir ? expanded : undefined}
      className={`flex items-center gap-1 pr-2 py-[3px] cursor-default [&_button]:cursor-default text-[13px] select-none focus:outline-none
        ${isDropTarget ? 'text-accent font-medium' : ''}
        ${!isDropTarget && isSelected ? 'bg-bg-active text-accent' : ''}
        ${!isDropTarget && !isSelected ? 'hover:bg-bg-hover focus-visible:bg-bg-hover' : ''}
        ${isCut || isDragging ? 'opacity-45' : ''}`}
      style={rowStyle}
      onPointerDown={event => onPointerDownNode(event, node)}
      onClick={event => {
        onSelectNode(node, event)
        if (event.ctrlKey || event.metaKey || event.shiftKey) return
        onOpenNode(node)
      }}
      onContextMenu={event => {
        event.currentTarget.focus()
        if (!pathSetHas(selectedPaths, node.path)) {
          onSelectNode(node, event)
        }
        onOpenContextMenu(event, { kind: 'node', node })
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onOpenNode(node)
          return
        }
        if (shortcutMatchesEvent('Ctrl+Shift+C', event.nativeEvent)) {
          event.preventDefault()
          onCopyPath(node.path)
          return
        }
        if (shortcutMatchesEvent(COPY_RELATIVE_PATH_SHORTCUT, event.nativeEvent)) {
          event.preventDefault()
          onCopyRelativePath(node.path)
          return
        }
        if (shortcutMatchesEvent('Alt+C', event.nativeEvent)) {
          event.preventDefault()
          onCopyAsReference(node.path)
        }
      }}
    >
      {node.is_dir ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            data-explorer-chevron=""
            aria-hidden="true"
            className="flex-shrink-0 rounded p-0 text-fg-dim hover:text-fg"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation()
              onSelectNode(node, event)
              onToggleFolder(node)
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {expanded ? (
            <FolderOpen size={15} className="text-accent flex-shrink-0" />
          ) : (
            <Folder size={15} className="text-accent flex-shrink-0" />
          )}
        </>
      ) : (
        <>
          <span className="w-[14px] flex-shrink-0" />
          <FileIcon size={14} className="text-fg-muted flex-shrink-0" />
        </>
      )}
      <Tooltip
        label={node.name}
        side="right"
        onlyWhenOverflow
        wrapperClassName="min-w-0 flex-1"
      >
        <span className={`block truncate min-w-0 ${gitColor || 'text-tree-fg'}`}>
          {node.name}
        </span>
      </Tooltip>
      {gitGlyph && (
        <span className={`ml-auto flex-shrink-0 text-[11px] font-medium ${gitColor}`}>
          {gitGlyph}
        </span>
      )}
      {loadingPaths.has(node.path) && (
        <RefreshCw
          size={12}
          className={`${gitGlyph ? 'ml-1' : 'ml-auto'} text-fg-dim animate-spin`}
        />
      )}
    </div>
  )
}
