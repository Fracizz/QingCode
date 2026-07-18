import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  File as FileIcon,
  FolderPlus,
  Plus,
  X,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  LocateFixed,
  Copy,
  FilePlus,
  Pencil,
  Trash2,
  EyeOff,
  ListChecks,
  Terminal as TerminalIcon,
  Search as SearchIcon,
  AtSign,
  GitCompare,
} from 'lucide-react'
import Tooltip from './Tooltip'
import { useProjectStore, type FileNode } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { safeInvoke } from '../lib/tauri'
import { openGitCompareWithHead } from '../lib/gitCompare'
import { gitStatusColorClass, gitStatusGlyph } from '../lib/gitStatus'
import { confirmDialog } from '../store/confirmStore'
import { promptDialog, validateEntryName } from '../store/promptStore'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import InlineCreateRow from './InlineCreateRow'
import type { Project } from '../types'
import {
  addPathToSet,
  collectAncestorDirs,
  copyToClipboard,
  formatFileReference,
  isDescendantOf,
  pathSetHas,
  pathsEqual,
} from '../utils/fileReferences'
import { findNodeByPath } from '../utils/fileTreeHelpers'
import {
  createTreeDepth,
  dirsToReveal,
  flattenVisibleNodes,
  type PendingCreate,
  type VisibleTreeRow,
} from '../utils/fileTreeView'
import { relocateProjectWithDialog, addTerminalProjectWithPrompt, renameProjectWithPrompt } from '../utils/projectActions'
import { confirmOutsideSymlinkWrite } from '../utils/symlinkWriteGuard'
import { formatBytes } from '../utils/formatBytes'
import { useI18n } from '../lib/i18n'

type DirectoryDeleteStats = {
  path: string
  fileCount: number
  totalSize: number
}

type ContextTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'node'; node: FileNode }
  | { kind: 'empty' }

function parentPath(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 ? path.slice(0, separator) : path
}

type TreeRowProps = {
  rows: VisibleTreeRow[]
  expandedPaths: Set<string>
  loadingPaths: Set<string>
  activeFilePath: string | null
  revealPath: string | null
  gitStatusFor: (path: string, isDir: boolean) => string | null
  onOpenContextMenu: (event: ReactMouseEvent, target: ContextTarget) => void
  onCopyPath: (path: string) => void
  onToggleNode: (node: FileNode) => void
  onCommitCreate: (name: string) => void
  onCancelCreate: () => void
}

function VirtualTreeRow({
  ariaAttributes,
  index,
  style,
  rows,
  expandedPaths,
  loadingPaths,
  activeFilePath,
  revealPath,
  gitStatusFor,
  onOpenContextMenu,
  onCopyPath,
  onToggleNode,
  onCommitCreate,
  onCancelCreate,
}: RowComponentProps<TreeRowProps>) {
  const row = rows[index]
  if (row.kind === 'create') {
    return (
      <div style={style} {...ariaAttributes}>
        <InlineCreateRow directory={row.directory} depth={row.depth} onSubmit={onCommitCreate} onCancel={onCancelCreate} />
      </div>
    )
  }

  const { node, depth } = row
  const expanded = node.is_dir && pathSetHas(expandedPaths, node.path)
  const isActive = !node.is_dir && activeFilePath != null && pathsEqual(node.path, activeFilePath)
  const isRevealed = revealPath != null && pathsEqual(node.path, revealPath)
  const rowStyle: CSSProperties = { ...style, paddingLeft: depth * 12 + 8 }
  const gitStatus = gitStatusFor(node.path, !!node.is_dir)
  const gitGlyph = gitStatusGlyph(gitStatus)
  const gitColor = gitStatusColorClass(gitStatus)
  // Indent guides: one faint vertical line per ancestor level, aligned to the chevron center.
  if (depth > 1) {
    rowStyle.backgroundImage =
      'repeating-linear-gradient(to right, color-mix(in srgb, var(--color-border-strong) 70%, transparent) 0 1px, transparent 1px 12px)'
    rowStyle.backgroundPosition = '27px 0'
    rowStyle.backgroundSize = `${(depth - 1) * 12 + 1}px 100%`
    rowStyle.backgroundRepeat = 'no-repeat'
  }

  return (
    <div
      {...ariaAttributes}
      tabIndex={0}
      className={`flex items-center gap-1 pr-2 py-[3px] cursor-pointer text-[13px] select-none focus:outline-none
        ${isActive || isRevealed ? 'bg-bg-active text-accent' : 'hover:bg-bg-hover focus:bg-bg-active'}`}
      style={rowStyle}
      onClick={() => onToggleNode(node)}
      onContextMenu={event => {
        event.currentTarget.focus()
        onOpenContextMenu(event, { kind: 'node', node })
      }}
      onKeyDown={event => {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
          event.preventDefault()
          onCopyPath(node.path)
        }
      }}
    >
      {node.is_dir ? (
        <>
          {expanded ? <ChevronDown size={14} className="text-fg-dim flex-shrink-0" /> : <ChevronRight size={14} className="text-fg-dim flex-shrink-0" />}
          {expanded ? <FolderOpen size={15} className="text-accent flex-shrink-0" /> : <Folder size={15} className="text-accent flex-shrink-0" />}
        </>
      ) : (
        <>
          <span className="w-[14px] flex-shrink-0" />
          <FileIcon size={14} className="text-fg-muted flex-shrink-0" />
        </>
      )}
      <span className={`truncate ${gitColor || 'text-fg'}`}>{node.name}</span>
      {gitGlyph && (
        <span className={`ml-auto flex-shrink-0 text-[11px] font-medium ${gitColor}`}>
          {gitGlyph}
        </span>
      )}
      {loadingPaths.has(node.path) && (
        <RefreshCw size={12} className={`${gitGlyph ? 'ml-1' : 'ml-auto'} text-fg-dim animate-spin`} />
      )}
    </div>
  )
}

export default function Sidebar() {
  const { t } = useI18n()
  const {
    projects,
    currentProject,
    projectTrees,
    unavailableProjectIds,
    switchProject,
    refreshProjectTree,
    expandProjectDir,
    revealFileInTree,
  } = useProjectStore()
  const hideProject = useProjectStore(s => s.hideProject)
  const openProjectManager = useUIStore(s => s.openProjectManager)
  const activeTabPath = useEditorStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId)
    return tab?.path ?? null
  })
  // Subscribe to the map so tree glyphs refresh when porcelain status changes.
  useGitStatusStore(s => s.statusByPath)
  const gitStatusFor = (path: string, isDir: boolean) =>
    isDir
      ? useGitStatusStore.getState().statusForDir(path)
      : useGitStatusStore.getState().statusFor(path)
  const setView = useUIStore(s => s.setView)
  const addTerminal = useTerminalStore(s => s.addTerminal)
  const requestSearch = useUIStore(s => s.requestSearch)
  const pendingNewFile = useUIStore(s => s.pendingNewFile)
  const clearPendingNewFile = useUIStore(s => s.clearPendingNewFile)
  const renameEditorPath = useEditorStore(s => s.renamePath)
  const closeTabsForPath = useEditorStore(s => s.closeTabsForPath)
  const [refreshing, setRefreshing] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    target: ContextTarget
  } | null>(null)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const listRef = useRef<ListImperativeAPI>(null)
  const treeRevealPath = useProjectStore(s => s.treeRevealPath)
  const treeRevealSeq = useProjectStore(s => s.treeRevealSeq)
  const tree = currentProject ? projectTrees[currentProject.id] ?? [] : []
  const visibleTreeRows = useMemo(
    () => flattenVisibleNodes(tree, expandedPaths, pendingCreate),
    [expandedPaths, pendingCreate, tree],
  )
  const revealingProjectRoot =
    !!currentProject &&
    !!treeRevealPath &&
    pathsEqual(treeRevealPath, currentProject.path)

  useEffect(() => {
    if (!currentProject || !treeRevealPath || !isDescendantOf(treeRevealPath, currentProject.path)) return
    if (pathsEqual(treeRevealPath, currentProject.path)) return

    const ancestors = collectAncestorDirs(treeRevealPath, currentProject.path)
    const target = findNodeByPath(tree, treeRevealPath)
    const toExpand = [
      ...ancestors.map(path => findNodeByPath(tree, path)?.path ?? path),
      ...(target?.is_dir ? [target.path] : []),
    ]
    if (toExpand.length === 0) return

    setExpandedPaths(existing => {
      let next = existing
      for (const path of toExpand) next = addPathToSet(next, path)
      return next === existing ? existing : new Set(next)
    })

    if (target?.is_dir && !target.loaded) {
      void expandProjectDir(currentProject.id, target.path)
    }
  }, [currentProject, expandProjectDir, tree, treeRevealPath, treeRevealSeq])

  useEffect(() => {
    if (!pendingCreate || !currentProject || pendingCreate.projectId !== currentProject.id) return
    setExpandedPaths(existing => {
      let next = existing
      for (const path of dirsToReveal(pendingCreate.parentPath, currentProject.path)) {
        next = addPathToSet(next, path)
      }
      return next === existing ? existing : new Set(next)
    })
  }, [currentProject, pendingCreate])

  useEffect(() => {
    if (!treeRevealPath || !currentProject) return
    if (pathsEqual(treeRevealPath, currentProject.path)) {
      listRef.current?.scrollToRow({ index: 0, align: 'start', behavior: 'smooth' })
      return
    }
    const targetIndex = pendingCreate
      ? visibleTreeRows.findIndex(row => row.kind === 'create')
      : visibleTreeRows.findIndex(
          row => row.kind === 'node' && pathsEqual(row.node.path, treeRevealPath),
        )
    if (targetIndex >= 0) {
      listRef.current?.scrollToRow({ index: targetIndex, align: 'smart', behavior: 'smooth' })
    }
  }, [currentProject, pendingCreate, treeRevealPath, treeRevealSeq, visibleTreeRows])

  const toggleTreeNode = async (node: FileNode) => {
    if (!node.is_dir) {
      void useEditorStore.getState().openFile(node.path)
      return
    }
    if (!currentProject) return
    const expanding = !pathSetHas(expandedPaths, node.path)
    setExpandedPaths(paths => {
      if (expanding) return addPathToSet(paths, node.path)
      const next = new Set<string>()
      for (const path of paths) {
        if (!pathsEqual(path, node.path)) next.add(path)
      }
      return next
    })
    if (!expanding || node.loaded) return
    setLoadingPaths(paths => new Set(paths).add(node.path))
    try {
      await expandProjectDir(currentProject.id, node.path)
    } finally {
      setLoadingPaths(paths => {
        const next = new Set(paths)
        next.delete(node.path)
        return next
      })
    }
  }

  const handleLocateActiveFile = () => {
    if (!activeTabPath) return
    setView('explorer')
    void revealFileInTree(activeTabPath)
  }

  const handleRefresh = async () => {
    if (refreshing || !currentProject) return
    setRefreshing(true)
    setExpandedPaths(new Set())
    try {
      await Promise.all([
        refreshProjectTree(currentProject),
        new Promise<void>(resolve => window.setTimeout(resolve, 1000)),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  const handleAddProject = async () => {
    await useProjectStore.getState().addProjectFromDialog()
  }

  const handleRemoveProject = (id: string, _name: string, _path: string) => {
    void hideProject(id)
  }

  const handleRelocateProject = (id: string) => {
    void relocateProjectWithDialog(id)
  }

  const handleOpenProject = async (path: string) => {
    try {
      await openPath(path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('打开项目目录失败: {error}', { error: String(e) }))
    }
  }

  const showContextMenu = (event: ReactMouseEvent, target: ContextTarget) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.focus()
    }
    setContextMenu({ x: event.clientX, y: event.clientY, target })
  }

  const copyPath = async (path: string) => {
    try {
      await copyToClipboard(path)
      useProjectStore.getState().pushToast('success', t('路径已复制'))
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('复制路径失败: {error}', { error: String(e) }))
    }
  }

  const projectOfPath = (path: string): Project | undefined => {
    const norm = path.replace(/\\/g, '/')
    return useProjectStore
      .getState()
      .projects.find(p => norm === p.path.replace(/\\/g, '/') || norm.startsWith(p.path.replace(/\\/g, '/') + '/'))
  }

  const copyAsReference = async (path: string) => {
    const project = projectOfPath(path)
    if (!project) {
      useProjectStore.getState().pushToast('error', t('无法确定该路径所属项目'))
      return
    }
    try {
      const ref = formatFileReference(project, path, 1)
      await copyToClipboard(ref)
      useProjectStore.getState().pushToast('success', t('文件引用已复制'))
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('复制引用失败: {error}', { error: String(e) }))
    }
  }

  const openTerminalHere = async (cwd: string) => {
    const project = projectOfPath(cwd)
    if (!project) {
      useProjectStore.getState().pushToast('error', t('无法确定该目录所属项目'))
      return
    }
    await addTerminal(cwd, project.id)
  }

  const refreshDirectory = async (path: string) => {
    const project = projectOfPath(path)
    if (!project) return
    if (path === project.path) await refreshProjectTree(project)
    else await expandProjectDir(project.id, path)
  }

  const cancelCreate = () => setPendingCreate(null)

  const commitCreate = async (name: string) => {
    if (!pendingCreate) return
    const { parentPath, directory, projectId } = pendingCreate
    const project = projects.find(p => p.id === projectId)
    if (!project) return
    const label = directory ? t('文件夹') : t('文件')
    const separator = parentPath.includes('\\') ? '\\' : '/'
    const candidatePath = `${parentPath.replace(/[\\/]+$/, '')}${separator}${name}`
    if (!(await confirmOutsideSymlinkWrite(candidatePath))) return
    setPendingCreate(null)
    try {
      const path = await safeInvoke<string>(
        t('新建{kind}', { kind: label }),
        directory ? 'create_directory' : 'create_file',
        { parent: parentPath, name }
      )
      await refreshDirectory(parentPath)
      useProjectStore.getState().pushToast('success', t('已新建{kind}: {name}', { kind: label, name }))
      if (!directory) await useEditorStore.getState().openFile(path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const startCreateEntry = async (parent: string, directory: boolean, projectId: string) => {
    const project = projects.find(p => p.id === projectId)
    if (!project) return
    if (currentProject?.id !== projectId) await switchProject(project)

    for (const dir of dirsToReveal(parent, project.path)) {
      await expandProjectDir(projectId, dir)
    }

    setPendingCreate({
      projectId,
      parentPath: parent,
      directory,
      depth: createTreeDepth(parent, project.path),
    })
  }

  useEffect(() => {
    if (!pendingNewFile) return
    clearPendingNewFile()
    const project = useProjectStore.getState().currentProject
    if (!project) return
    if (useProjectStore.getState().unavailableProjectIds.includes(project.id)) {
      useProjectStore.getState().pushToast('info', t('目录不可用，请重新定位'))
      return
    }
    void startCreateEntry(project.path, false, project.id)
    // Consume once per pending flag; startCreateEntry uses latest project state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNewFile])

  const handleRenameNode = async (node: FileNode) => {
    const name = await promptDialog({
      title: t('重命名'),
      message: node.is_dir ? t('文件夹新名称') : t('文件新名称'),
      defaultValue: node.name,
      validate: validateEntryName,
      confirmLabel: t('重命名'),
    })
    if (!name || name === node.name) return
    try {
      const newPath = await safeInvoke<string>('重命名', 'rename_path', {
        path: node.path,
        newName: name,
      })
      renameEditorPath(node.path, newPath)
      await refreshDirectory(parentPath(node.path))
      useProjectStore.getState().pushToast('success', t('已重命名为: {name}', { name }))
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const handleDeleteNode = async (node: FileNode) => {
    const confirmed = await confirmDialog({
      title: t('永久删除'),
      message: t('确定永久删除{kind}「{name}」？', { kind: node.is_dir ? t('文件夹') : t('文件'), name: node.name }),
      detail: node.is_dir
        ? t('文件夹内的全部内容都会被删除，且无法撤销。')
        : t('此操作无法撤销。'),
      kind: 'danger',
      confirmLabel: t('删除'),
      cancelLabel: t('取消'),
    })
    if (confirmed !== true) return

    if (node.is_dir) {
      let detail = t('路径：{path}', { path: node.path })
      try {
        const stats = await safeInvoke<DirectoryDeleteStats>('统计文件夹', 'directory_delete_stats', {
          path: node.path,
        })
        detail = [
          t('路径：{path}', { path: stats.path || node.path }),
          t('包含 {count} 个文件（约 {size}）', {
            count: stats.fileCount,
            size: formatBytes(stats.totalSize),
          }),
        ].join('\n')
      } catch {
        // Path-only secondary confirm is still useful if stats fail.
      }
      const confirmedAgain = await confirmDialog({
        title: t('再次确认删除文件夹'),
        message: t('即将永久删除以下文件夹：'),
        detail,
        kind: 'danger',
        confirmLabel: t('永久删除'),
        cancelLabel: t('取消'),
      })
      if (confirmedAgain !== true) return
    }

    try {
      await safeInvoke('删除', 'delete_path', { path: node.path })
      closeTabsForPath(node.path)
      await refreshDirectory(parentPath(node.path))
      useProjectStore.getState().pushToast('success', t('已删除: {name}', { name: node.name }))
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const revealNode = async (node: FileNode) => {
    try {
      if (node.is_dir) await openPath(node.path)
      else await revealItemInDir(node.path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('在文件管理器中打开失败: {error}', { error: String(e) }))
    }
  }

  const contextMenuItems = (target: ContextTarget): ContextMenuItem[] => {
    if (target.kind === 'empty') {
      return [
        {
          label: t('添加文件夹项目'),
          icon: <FolderPlus size={14} />,
          action: handleAddProject,
        },
        {
          label: t('新建草稿项目'),
          icon: <TerminalIcon size={14} />,
          action: () => addTerminalProjectWithPrompt(),
        },
        {
          label: t('项目管理'),
          icon: <ListChecks size={14} />,
          separatorBefore: true,
          action: openProjectManager,
        },
        {
          label: t('刷新'),
          icon: <RefreshCw size={14} />,
          separatorBefore: true,
          disabled: !currentProject,
          action: handleRefresh,
        },
      ]
    }
    if (target.kind === 'project') {
      const project = target.project
      const unavailable = unavailableProjectIds.includes(project.id)
      const activateThen = async (action: () => Promise<void>) => {
        if (currentProject?.id !== project.id) await switchProject(project)
        await action()
      }
      return [
        {
          label: currentProject?.id === project.id ? t('当前项目') : t('切换到此项目'),
          icon: <FolderOpen size={14} />,
          disabled: currentProject?.id === project.id || unavailable,
          action: () => switchProject(project),
        },
        {
          label: t('新建终端'),
          icon: <TerminalIcon size={14} />,
          disabled: unavailable,
          action: () => addTerminal(project.path, project.id),
        },
        {
          label: t('在此项目内搜索'),
          icon: <SearchIcon size={14} />,
          disabled: unavailable,
          action: () => requestSearch(project.path),
        },
        {
          label: t('新建文件'),
          icon: <FilePlus size={14} />,
          separatorBefore: true,
          disabled: unavailable,
          action: () => activateThen(() => startCreateEntry(project.path, false, project.id)),
        },
        {
          label: t('新建文件夹'),
          icon: <FolderPlus size={14} />,
          disabled: unavailable,
          action: () => activateThen(() => startCreateEntry(project.path, true, project.id)),
        },
        {
          label: t('刷新项目'),
          icon: <RefreshCw size={14} />,
          disabled: unavailable,
          separatorBefore: true,
          action: () => activateThen(() => refreshProjectTree(project)),
        },
        {
          label: t('在文件管理器中打开'),
          icon: <ExternalLink size={14} />,
          disabled: unavailable,
          action: () => handleOpenProject(project.path),
        },
        {
          label: t('复制路径'),
          icon: <Copy size={14} />,
          shortcut: 'Ctrl+Shift+C',
          action: () => copyPath(project.path),
        },
        {
          label: t('复制为文件引用'),
          icon: <AtSign size={14} />,
          action: () => copyAsReference(project.path),
        },
        {
          label: t('重命名项目'),
          icon: <Pencil size={14} />,
          separatorBefore: true,
          action: () => renameProjectWithPrompt(project.id, project.name),
        },
        {
          label: t('重新定位项目'),
          icon: <LocateFixed size={14} />,
          action: () => handleRelocateProject(project.id),
        },
        {
          label: t('从顶栏隐藏'),
          icon: <EyeOff size={14} />,
          action: () => handleRemoveProject(project.id, project.name, project.path),
        },
        {
          label: t('项目管理'),
          icon: <ListChecks size={14} />,
          separatorBefore: true,
          action: openProjectManager,
        },
      ]
    }

    const node = target.node
    const parent = node.is_dir ? node.path : parentPath(node.path)
    const project = projectOfPath(parent)
    return [
      ...(!node.is_dir
        ? [
            {
              label: t('打开文件'),
              icon: <FileIcon size={14} />,
              action: () => useEditorStore.getState().openFile(node.path),
            },
            {
              label: t('与 Git HEAD 比较'),
              icon: <GitCompare size={14} />,
              action: () => void openGitCompareWithHead(node.path),
            },
            {
              label: t('新建文件（同目录）'),
              icon: <FilePlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(parent, false, project.id),
            },
            {
              label: t('新建文件夹（同目录）'),
              icon: <FolderPlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(parent, true, project.id),
            },
          ]
        : [
            {
              label: t('新建文件'),
              icon: <FilePlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(node.path, false, project.id),
            },
            {
              label: t('新建文件夹'),
              icon: <FolderPlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(node.path, true, project.id),
            },
            {
              label: t('在此处打开终端'),
              icon: <TerminalIcon size={14} />,
              separatorBefore: true,
              action: () => openTerminalHere(node.path),
            },
            {
              label: t('在此文件夹中搜索'),
              icon: <SearchIcon size={14} />,
              action: () => requestSearch(node.path),
            },
          ]),
      {
        label: t('重命名'),
        icon: <Pencil size={14} />,
        separatorBefore: true,
        action: () => handleRenameNode(node),
      },
      {
        label: t('复制路径'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        action: () => copyPath(node.path),
      },
      {
        label: t('复制为文件引用'),
        icon: <AtSign size={14} />,
        action: () => copyAsReference(node.path),
      },
      {
        label: node.is_dir ? t('在文件管理器中打开') : t('在文件管理器中显示'),
        icon: <ExternalLink size={14} />,
        action: () => revealNode(node),
      },
      {
        label: t('永久删除'),
        icon: <Trash2 size={14} />,
        danger: true,
        separatorBefore: true,
        action: () => handleDeleteNode(node),
      },
    ]
  }

  return (
    <div
      className="ui-font-scaled h-full flex flex-col bg-bg-sidebar text-fg"
      onContextMenu={event =>
        showContextMenu(
          event,
          currentProject ? { kind: 'project', project: currentProject } : { kind: 'empty' }
        )
      }
    >
      {/* Section header */}
      <div className="px-4 h-9 flex items-center justify-between text-[11px] font-semibold tracking-wide text-fg-muted">
        <span>{t('资源管理器')}</span>
        <div className="flex items-center gap-0.5">
          <Tooltip label={t('在侧边栏定位当前文件')} side="bottom">
            <button
              type="button"
              onClick={handleLocateActiveFile}
              disabled={!activeTabPath}
              aria-label={t('在侧边栏定位当前文件')}
              className={`p-1 rounded transition-colors flex-shrink-0
              ${!activeTabPath
                ? 'opacity-40'
                : 'text-fg-dim hover:text-fg hover:bg-bg-hover'}`}
            >
              <LocateFixed size={13} />
            </button>
          </Tooltip>
          <Tooltip label={t('刷新')} side="bottom">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing || !currentProject}
              aria-label={t('刷新')}
              aria-busy={refreshing}
              className={`p-1 rounded transition-colors flex-shrink-0
              ${!currentProject
                ? 'opacity-40'
                : 'text-fg-dim hover:text-fg hover:bg-bg-hover'}`}
            >
              <RefreshCw
                size={13}
                className={refreshing ? 'text-accent animate-spin' : undefined}
              />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Current project tree only — project switching lives in the title bar picker */}
      <div className="flex-1 min-h-0 flex flex-col pb-3">
        {!currentProject ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[13px] text-fg-muted mb-3">{t('未打开项目')}</p>
            <button
              onClick={handleAddProject}
              className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded bg-bg-elevated hover:bg-bg-active border border-border-strong text-fg"
            >
              <Plus size={14} /> {t('添加项目')}
            </button>
          </div>
        ) : (
          (() => {
            const unavailable = unavailableProjectIds.includes(currentProject.id)
            return (
              <>
                <div
                  className={`group flex items-center gap-1 pl-3 pr-2 py-[5px] text-[13px] select-none cursor-default ${
                    revealingProjectRoot ? 'bg-bg-active text-accent' : 'text-fg'
                  }`}
                  onContextMenu={event =>
                    showContextMenu(event, { kind: 'project', project: currentProject })
                  }
                >
                  {unavailable ? (
                    <AlertTriangle size={15} className="text-warn flex-shrink-0" />
                  ) : (
                    <FolderOpen size={15} className="text-accent flex-shrink-0" />
                  )}
                  <Tooltip
                    label={currentProject.path}
                    side="bottom"
                    wrapperClassName="truncate min-w-0 flex-1"
                  >
                    <span className="truncate font-medium">{currentProject.name}</span>
                  </Tooltip>
                  <Tooltip label={t('新建文件')} side="bottom">
                    <button
                      type="button"
                      aria-label={t('新建文件')}
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void startCreateEntry(currentProject.path, false, currentProject.id)
                      }}
                    >
                      <FilePlus size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('新建文件夹')} side="bottom">
                    <button
                      type="button"
                      aria-label={t('新建文件夹')}
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void startCreateEntry(currentProject.path, true, currentProject.id)
                      }}
                    >
                      <FolderPlus size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('新建终端')} side="bottom">
                    <button
                      type="button"
                      aria-label={t('新建终端')}
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void addTerminal(currentProject.path, currentProject.id)
                      }}
                    >
                      <TerminalIcon size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('在文件管理器中打开')} side="bottom">
                    <button
                      type="button"
                      aria-label={t('在文件管理器中打开')}
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void handleOpenProject(currentProject.path)
                      }}
                    >
                      <ExternalLink size={13} />
                    </button>
                  </Tooltip>
                  {unavailable ? (
                    <Tooltip label={t('重新定位项目')} side="bottom">
                      <button
                        type="button"
                        aria-label={t('重新定位项目')}
                        className="p-0.5 text-warn hover:text-fg"
                        onClick={event => {
                          event.stopPropagation()
                          handleRelocateProject(currentProject.id)
                        }}
                      >
                        <LocateFixed size={13} />
                      </button>
                    </Tooltip>
                  ) : (
                    <Tooltip label={t('从顶栏隐藏')} side="bottom">
                      <button
                        type="button"
                        aria-label={t('从顶栏隐藏')}
                        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-fg-dim hover:text-danger"
                        onClick={event => {
                          event.stopPropagation()
                          handleRemoveProject(
                            currentProject.id,
                            currentProject.name,
                            currentProject.path,
                          )
                        }}
                      >
                        <X size={13} />
                      </button>
                    </Tooltip>
                  )}
                </div>

                <div
                  className="flex-1 min-h-0 flex flex-col"
                  onContextMenu={event =>
                    showContextMenu(event, { kind: 'project', project: currentProject })
                  }
                >
                  {unavailable ? (
                    <div className="px-4 py-2 text-[12px] text-warn flex items-center gap-1.5">
                      <AlertTriangle size={12} /> {t('目录不可用，请重新定位')}
                    </div>
                  ) : (
                    <>
                      {pendingCreate?.parentPath === currentProject.path && (
                        <InlineCreateRow
                          directory={pendingCreate.directory}
                          depth={pendingCreate.depth}
                          onSubmit={name => void commitCreate(name)}
                          onCancel={cancelCreate}
                        />
                      )}
                      {tree.length === 0 &&
                        pendingCreate?.parentPath !== currentProject.path && (
                          <div className="px-4 py-2 text-[12px] text-fg-muted">{t('空文件夹')}</div>
                        )}
                      {visibleTreeRows.length > 0 && (
                        <List
                          listRef={listRef}
                          rowComponent={VirtualTreeRow}
                          rowCount={visibleTreeRows.length}
                          rowHeight={index => visibleTreeRows[index]?.kind === 'create' ? 30 : 26}
                          rowProps={{
                            rows: visibleTreeRows,
                            expandedPaths,
                            loadingPaths,
                            activeFilePath: activeTabPath,
                            revealPath: treeRevealPath,
                            gitStatusFor,
                            onOpenContextMenu: showContextMenu,
                            onCopyPath: copyPath,
                            onToggleNode: toggleTreeNode,
                            onCommitCreate: name => void commitCreate(name),
                            onCancelCreate: cancelCreate,
                          }}
                          overscanCount={12}
                          className="flex-1 min-h-0"
                          style={{ width: '100%' }}
                        />
                      )}
                    </>
                  )}
                </div>
              </>
            )
          })()
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu.target)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
