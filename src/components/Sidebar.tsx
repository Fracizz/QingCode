import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { List, type ListImperativeAPI } from 'react-window'
import {
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
  Info,
  Scissors,
  ClipboardPaste,
  ClipboardCopy,
} from 'lucide-react'
import Tooltip from './Tooltip'
import { useProjectStore, type FileNode } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { safeInvoke } from '../lib/tauri'
import { openGitCompareWithHead } from '../lib/gitCompare'
import { confirmDialog } from '../store/confirmStore'
import {
  findExplorerNameConflict,
  resolveExplorerNameConflict,
} from '../utils/explorerNameConflict'
import { showPropertiesDialog } from '../store/propertiesStore'
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
import { baseName, findNodeByPath } from '../utils/fileTreeHelpers'
import {
  createTreeDepth,
  dirsToReveal,
  findVisibleNodeRowIndex,
  flattenVisibleNodes,
  moveVisibleNodeSelection,
  resolveTreeRevealScrollIndex,
  type PendingCreate,
  type PendingRename,
} from '../utils/fileTreeView'
import {
  relocateProjectWithDialog,
  addTerminalProjectWithPrompt,
  renameProjectWithPrompt,
  removeProjectWithConfirm,
} from '../utils/projectActions'
import { confirmOutsideSymlinkWrite } from '../utils/symlinkWriteGuard'
import { formatBytes } from '../utils/formatBytes'
import { useI18n } from '../lib/i18n'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import {
  COPY_RELATIVE_PATH_SHORTCUT,
  isShortcutBound,
  shortcutMatchesEvent,
} from '../lib/shortcuts'
import { copyRelativePathAction } from '../lib/copyFileActions'
import { useShortcutStore } from '../store/shortcutStore'
import ExplorerTreeRow from './ExplorerTreeRow'

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

const EXPLORER_DROP_ATTR = 'data-explorer-drop'
const DRAG_THRESHOLD_PX = 5
const EMPTY_TREE: FileNode[] = []

/** Hit-test explorer drop targets (pointer DnD; avoids flaky HTML5 DnD in WebView2). */
function resolveExplorerDropFromPoint(
  clientX: number,
  clientY: number,
): { path: string; isDir: boolean } | null {
  const el = document.elementFromPoint(clientX, clientY)
  const row = el?.closest(`[${EXPLORER_DROP_ATTR}]`) as HTMLElement | null
  const path = row?.getAttribute(EXPLORER_DROP_ATTR)
  if (!path) return null
  return { path, isDir: row?.getAttribute('data-explorer-isdir') === '1' }
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
  const renameShortcut = useShortcutStore(s => s.shortcuts.renameInExplorer)
  const [refreshing, setRefreshing] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    items: ContextMenuItem[]
  } | null>(null)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  /** Primary selection (keyboard / range anchor). */
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [clipboard, setClipboard] = useState<{ mode: 'cut' | 'copy'; paths: string[] } | null>(
    null,
  )
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const [draggingPaths, setDraggingPaths] = useState<Set<string>>(() => new Set())
  const [dragGhost, setDragGhost] = useState<{
    x: number
    y: number
    label: string
  } | null>(null)
  const listRef = useRef<ListImperativeAPI>(null)
  const treeFocusRef = useRef<HTMLDivElement>(null)
  const suppressTreeClickRef = useRef(false)
  const explorerDragRef = useRef<{
    paths: string[]
    startX: number
    startY: number
    active: boolean
    pointerId: number
  } | null>(null)
  const scrolledRevealSeqRef = useRef(0)
  const preserveScrollTopRef = useRef<number | null>(null)
  const treeRevealPath = useProjectStore(s => s.treeRevealPath)
  const treeRevealSeq = useProjectStore(s => s.treeRevealSeq)
  const tree = currentProject ? projectTrees[currentProject.id] ?? EMPTY_TREE : EMPTY_TREE
  const visibleTreeRows = useMemo(
    () => flattenVisibleNodes(tree, expandedPaths, pendingCreate, pendingRename),
    [expandedPaths, pendingCreate, pendingRename, tree],
  )
  const cutPaths = useMemo(
    () => new Set(clipboard?.mode === 'cut' ? clipboard.paths : []),
    [clipboard],
  )
  const isProjectRootSelected =
    !!currentProject && selectedPath != null && pathsEqual(selectedPath, currentProject.path)

  const replaceSelection = useCallback((path: string | null) => {
    setSelectedPath(path)
    setSelectedPaths(path ? new Set([path]) : new Set())
  }, [])

  useEffect(() => {
    queueMicrotask(() => {
      replaceSelection(null)
      setClipboard(null)
      setPendingRename(null)
    })
    scrolledRevealSeqRef.current = 0
  }, [currentProject?.id, replaceSelection])

  useEffect(() => {
    if (treeRevealPath) queueMicrotask(() => replaceSelection(treeRevealPath))
  }, [treeRevealPath, treeRevealSeq, replaceSelection])

  useEffect(() => {
    if (!currentProject || !treeRevealPath || !isDescendantOf(treeRevealPath, currentProject.path)) return
    if (pathsEqual(treeRevealPath, currentProject.path)) return

    const ancestors = collectAncestorDirs(treeRevealPath, currentProject.path)
    const target = findNodeByPath(tree, treeRevealPath)
    const toExpand = [
      ...ancestors.map(path => findNodeByPath(tree, path)?.path ?? path),
      ...(target?.is_dir ? [target.path] : []),
    ].filter(path => isDescendantOf(path, currentProject.path) || pathsEqual(path, currentProject.path))
    if (toExpand.length === 0) return

    queueMicrotask(() =>
      setExpandedPaths(existing => {
        let next = existing
        for (const path of toExpand) next = addPathToSet(next, path)
        return next === existing ? existing : new Set(next)
      }),
    )

    if (target?.is_dir && !target.loaded) {
      void expandProjectDir(currentProject.id, target.path)
    }
  }, [currentProject, expandProjectDir, tree, treeRevealPath, treeRevealSeq])

  useEffect(() => {
    if (!pendingCreate || !currentProject || pendingCreate.projectId !== currentProject.id) return
    queueMicrotask(() =>
      setExpandedPaths(existing => {
        let next = existing
        for (const path of dirsToReveal(pendingCreate.parentPath, currentProject.path)) {
          next = addPathToSet(next, path)
        }
        return next === existing ? existing : new Set(next)
      }),
    )
  }, [currentProject, pendingCreate])

  useEffect(() => {
    if (!treeRevealPath || !currentProject) return
    // Only scroll for an explicit reveal (treeRevealSeq bump). Row-count changes from
    // manual expand/collapse must not re-run scroll-into-view for the active tab path.
    if (scrolledRevealSeqRef.current === treeRevealSeq) return

    const targetIndex = resolveTreeRevealScrollIndex(
      visibleTreeRows,
      treeRevealPath,
      currentProject.path,
      pendingCreate,
    )
    if (targetIndex == null || visibleTreeRows.length === 0) return

    listRef.current?.scrollToRow({ index: targetIndex, align: 'smart', behavior: 'auto' })
    scrolledRevealSeqRef.current = treeRevealSeq
  }, [currentProject, pendingCreate, treeRevealPath, treeRevealSeq, visibleTreeRows])

  useLayoutEffect(() => {
    if (preserveScrollTopRef.current == null) return
    const top = preserveScrollTopRef.current
    preserveScrollTopRef.current = null
    listRef.current?.element?.scrollTo({ top, behavior: 'instant' })
  }, [visibleTreeRows])

  const toggleFolderExpand = useCallback(
    async (node: FileNode) => {
      if (!node.is_dir || !currentProject) return
      preserveScrollTopRef.current = listRef.current?.element?.scrollTop ?? null
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
    },
    [currentProject, expandedPaths, expandProjectDir],
  )

  const selectTreeNode = useCallback(
    (node: FileNode, event?: ReactMouseEvent) => {
      if (suppressTreeClickRef.current) {
        event?.preventDefault()
        event?.stopPropagation()
        return
      }
      treeFocusRef.current?.focus()
      const ctrl = Boolean(event?.ctrlKey || event?.metaKey)
      const shift = Boolean(event?.shiftKey)

      if (shift) {
        const anchor = selectedPath ?? node.path
        const start = findVisibleNodeRowIndex(visibleTreeRows, anchor)
        const end = findVisibleNodeRowIndex(visibleTreeRows, node.path)
        if (start >= 0 && end >= 0) {
          const [lo, hi] = start < end ? [start, end] : [end, start]
          const next = new Set<string>()
          for (let i = lo; i <= hi; i++) {
            const row = visibleTreeRows[i]
            if (row?.kind === 'node' || row?.kind === 'rename') next.add(row.node.path)
          }
          setSelectedPaths(next)
          setSelectedPath(node.path)
          return
        }
      }

      if (ctrl) {
        setSelectedPaths(prev => {
          const next = new Set(prev)
          if (pathSetHas(next, node.path)) {
            const filtered = [...next].filter(p => !pathsEqual(p, node.path))
            return new Set(filtered)
          }
          return addPathToSet(next, node.path)
        })
        setSelectedPath(node.path)
        return
      }

      replaceSelection(node.path)
    },
    [replaceSelection, selectedPath, visibleTreeRows],
  )

  const scrollTreeRowIntoView = useCallback(
    (path: string) => {
      const index = findVisibleNodeRowIndex(visibleTreeRows, path)
      if (index >= 0) {
        listRef.current?.scrollToRow({ index, align: 'smart', behavior: 'auto' })
      }
    },
    [visibleTreeRows],
  )

  const openTreeNode = useCallback(
    (node: FileNode) => {
      // Skip activation after a drag (pointerup still synthesizes a click).
      if (suppressTreeClickRef.current) return
      if (node.is_dir) {
        void toggleFolderExpand(node)
        return
      }
      void useEditorStore.getState().openFile(node.path)
    },
    [toggleFolderExpand],
  )

  const handleTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (visibleTreeRows.length === 0) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        const direction =
          event.key === 'ArrowDown'
            ? 'down'
            : event.key === 'ArrowUp'
              ? 'up'
              : event.key === 'Home'
                ? 'home'
                : 'end'
        const next = moveVisibleNodeSelection(visibleTreeRows, selectedPath, direction)
        if (next) {
          if (event.shiftKey) {
            selectTreeNode(next, {
              shiftKey: true,
              ctrlKey: false,
              metaKey: false,
            } as ReactMouseEvent)
          } else {
            replaceSelection(next.path)
          }
          scrollTreeRowIntoView(next.path)
        }
        return
      }

      if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && selectedPath) {
        const node = findNodeByPath(tree, selectedPath)
        if (!node?.is_dir) return
        event.preventDefault()
        const expanded = pathSetHas(expandedPaths, node.path)
        if (event.key === 'ArrowRight' && !expanded) void toggleFolderExpand(node)
        else if (event.key === 'ArrowLeft' && expanded) void toggleFolderExpand(node)
        return
      }

      if (event.key === 'Enter' && selectedPath) {
        const node = findNodeByPath(tree, selectedPath)
        if (!node) return
        event.preventDefault()
        openTreeNode(node)
      }
    },
    [
      expandedPaths,
      replaceSelection,
      scrollTreeRowIntoView,
      selectedPath,
      selectTreeNode,
      tree,
      openTreeNode,
      toggleFolderExpand,
      visibleTreeRows,
    ],
  )

  const handleLocateActiveFile = () => {
    if (!activeTabPath) return
    setView('explorer')
    void revealFileInTree(activeTabPath, { force: true })
  }

  const handleRefresh = async () => {
    if (refreshing || !currentProject) return
    setRefreshing(true)
    try {
      await refreshProjectTree(currentProject)
    } finally {
      setRefreshing(false)
    }
  }

  const handleAddProject = async () => {
    await useProjectStore.getState().addProjectFromDialog()
  }

  const handleRemoveProject = (id: string, name: string, path: string) => {
    if (useProjectStore.getState().unavailableProjectIds.includes(id)) {
      void removeProjectWithConfirm(id, name, path)
      return
    }
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
    if (!shouldShowAppContextMenu(event)) return
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.focus()
    }
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: contextMenuItems(target),
    })
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
    // Must force-reload: expandProjectDir no-ops when already loaded, which left
    // deleted/moved entries visible after mutations.
    if (pathsEqual(path, project.path)) await refreshProjectTree(project)
    else await expandProjectDir(project.id, path, { force: true })
  }

  const pruneTreePaths = (removedPaths: string[]) => {
    if (removedPaths.length === 0) return
    const isGone = (path: string) =>
      removedPaths.some(removed => pathsEqual(path, removed) || isDescendantOf(path, removed))

    setExpandedPaths(prev => {
      const next = new Set<string>()
      for (const path of prev) {
        if (!isGone(path)) next.add(path)
      }
      return next.size === prev.size ? prev : next
    })
    setSelectedPaths(prev => {
      const next = new Set([...prev].filter(path => !isGone(path)))
      return next.size === prev.size ? prev : next
    })
    if (selectedPath && isGone(selectedPath)) {
      setSelectedPath(null)
    }
    setClipboard(prev => {
      if (!prev) return prev
      const paths = prev.paths.filter(path => !isGone(path))
      return paths.length === 0 ? null : { ...prev, paths }
    })
  }

  const cancelCreate = () => setPendingCreate(null)
  const cancelRename = () => setPendingRename(null)

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

    setPendingRename(null)
    setPendingCreate({
      projectId,
      parentPath: parent,
      directory,
      depth: createTreeDepth(parent, project.path),
    })
  }

  const startInlineRename = (node: FileNode) => {
    setPendingCreate(null)
    setPendingRename({
      path: node.path,
      name: node.name,
      isDir: node.is_dir,
      depth: createTreeDepth(parentPath(node.path), currentProject?.path ?? parentPath(node.path)),
    })
    replaceSelection(node.path)
  }

  const commitRename = async (name: string) => {
    if (!pendingRename) return
    const { path, name: oldName } = pendingRename
    if (!name || name === oldName) {
      setPendingRename(null)
      return
    }
    setPendingRename(null)
    try {
      const newPath = await safeInvoke<string>('重命名', 'rename_path', {
        path,
        newName: name,
      })
      renameEditorPath(path, newPath)
      await refreshDirectory(parentPath(path))
      replaceSelection(newPath)
      useProjectStore.getState().pushToast('success', t('已重命名为: {name}', { name }))
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const pathsForClipboardAction = (anchorPath?: string): string[] => {
    if (selectedPaths.size > 0) {
      if (!anchorPath || pathSetHas(selectedPaths, anchorPath)) {
        return [...selectedPaths]
      }
    }
    return anchorPath ? [anchorPath] : selectedPath ? [selectedPath] : []
  }

  const cutExplorerPaths = (anchorPath?: string) => {
    const paths = pathsForClipboardAction(anchorPath)
    if (paths.length === 0) return
    setClipboard({ mode: 'cut', paths })
    useProjectStore.getState().pushToast('success', t('已剪切 {count} 项', { count: paths.length }))
  }

  const copyExplorerPaths = (anchorPath?: string) => {
    const paths = pathsForClipboardAction(anchorPath)
    if (paths.length === 0) return
    setClipboard({ mode: 'copy', paths })
    useProjectStore.getState().pushToast('success', t('已复制 {count} 项', { count: paths.length }))
  }

  const copyFilesToSystemClipboard = async (anchorPath?: string) => {
    const paths = pathsForClipboardAction(anchorPath)
    if (paths.length === 0) return
    try {
      await safeInvoke('写入系统剪贴板', 'clipboard_write_files', { paths })
      useProjectStore
        .getState()
        .pushToast('success', t('已复制文件到剪贴板（{count} 项）', { count: paths.length }))
    } catch (error) {
      useProjectStore.getState().pushToast(
        'error',
        t('复制文件到剪贴板失败：{error}', { error: String(error) }),
      )
    }
  }

  const resolvePasteDest = (hintPath?: string): string | null => {
    if (!currentProject) return null
    const path = hintPath ?? selectedPath ?? currentProject.path
    if (pathsEqual(path, currentProject.path)) return currentProject.path
    const node = findNodeByPath(tree, path)
    if (node?.is_dir) return node.path
    return parentPath(path)
  }

  const transferExplorerPaths = async (
    paths: string[],
    destDir: string,
    mode: 'cut' | 'copy',
  ): Promise<number> => {
    let ok = 0
    const parentsToRefresh = new Set<string>([destDir])
    const movedSources: string[] = []
    const applyAll: { current: 'overwrite' | 'skip' | null } = { current: null }
    const pending = paths.filter(source => {
      if (mode === 'cut' && (pathsEqual(source, destDir) || isDescendantOf(destDir, source))) {
        return false
      }
      if (mode === 'cut' && pathsEqual(parentPath(source), destDir)) return false
      return true
    })

    for (let i = 0; i < pending.length; i++) {
      const source = pending[i]
      const conflict = await findExplorerNameConflict(source, destDir)
      let conflictPolicy: 'overwrite' | 'fail' = 'fail'
      let destName: string | undefined
      if (conflict) {
        const decision = await resolveExplorerNameConflict({
          conflict,
          operation: mode === 'cut' ? 'move' : 'copy',
          remainingCount: pending.length - i,
          applyAll,
        })
        if (decision.action === 'cancel') break
        if (decision.action === 'skip') continue
        if (decision.action === 'overwrite') {
          conflictPolicy = 'overwrite'
          closeTabsForPath(conflict.destPath)
        } else {
          destName = decision.newName
          // Custom name: fail if that name also exists (dialog already asked for a new name).
          conflictPolicy = 'fail'
        }
      }

      const command = mode === 'cut' ? 'move_path' : 'copy_path_into'
      const newPath = await safeInvoke<string>(mode === 'cut' ? t('移动') : t('复制'), command, {
        path: source,
        destDir,
        conflictPolicy,
        ...(destName ? { destName } : {}),
      })
      if (mode === 'cut') {
        renameEditorPath(source, newPath)
        parentsToRefresh.add(parentPath(source))
        movedSources.push(source)
      }
      ok += 1
    }

    if (mode === 'cut' && movedSources.length > 0) pruneTreePaths(movedSources)
    for (const parent of parentsToRefresh) {
      await refreshDirectory(parent)
    }
    if (ok > 0) setExpandedPaths(existing => addPathToSet(existing, destDir))
    return ok
  }

  const pasteExplorerClipboard = async (hintPath?: string) => {
    if (!clipboard || !currentProject) return
    const destDir = resolvePasteDest(hintPath)
    if (!destDir) return
    const { mode, paths } = clipboard
    try {
      const ok = await transferExplorerPaths(paths, destDir, mode)
      if (mode === 'cut') setClipboard(null)
      if (ok > 0) {
        useProjectStore
          .getState()
          .pushToast('success', t('已粘贴 {count} 项', { count: ok }))
      }
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('粘贴失败: {error}', { error: String(e) }))
    }
  }

  const moveExplorerPaths = async (paths: string[], destDir: string) => {
    if (!currentProject || paths.length === 0) return
    try {
      const moved = await transferExplorerPaths(paths, destDir, 'cut')
      if (moved > 0) {
        useProjectStore.getState().pushToast('success', t('已移动 {count} 项', { count: moved }))
      }
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('移动失败: {error}', { error: String(e) }))
    }
  }

  const handlePointerDownNode = (event: ReactPointerEvent, node: FileNode) => {
    if (event.button !== 0 || pendingRename || pendingCreate) return
    if ((event.target as HTMLElement | null)?.closest?.('[data-explorer-chevron]')) return

    const paths =
      pathSetHas(selectedPaths, node.path) && selectedPaths.size > 0
        ? [...selectedPaths]
        : [node.path]
    const sourceLabel =
      paths.length === 1 ? node.name : t('移动 {count} 项', { count: paths.length })
    explorerDragRef.current = {
      paths,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      pointerId: event.pointerId,
    }

    const dropDestLabel = (destDir: string): string => {
      if (currentProject && pathsEqual(destDir, currentProject.path)) return currentProject.name
      return baseName(destDir)
    }

    const clearListeners = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    const onMove = (moveEvent: PointerEvent) => {
      const session = explorerDragRef.current
      if (!session || moveEvent.pointerId !== session.pointerId) return
      const dx = moveEvent.clientX - session.startX
      const dy = moveEvent.clientY - session.startY
      if (!session.active) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
        session.active = true
        suppressTreeClickRef.current = true
        setDraggingPaths(new Set(session.paths))
        if (!pathSetHas(selectedPaths, node.path)) replaceSelection(node.path)
      }

      const target = resolveExplorerDropFromPoint(moveEvent.clientX, moveEvent.clientY)
      const invalid =
        !target || session.paths.some(p => pathsEqual(p, target.path))
      if (invalid) {
        setDragOverPath(null)
        setDragGhost({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          label: sourceLabel,
        })
        return
      }

      const destDir = target.isDir ? target.path : parentPath(target.path)
      // Same-folder drop is a no-op; still show destination so the hint stays clear.
      setDragOverPath(prev => (prev != null && pathsEqual(prev, target.path) ? prev : target.path))
      setDragGhost({
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        label: t('移动到 {name}', { name: dropDestLabel(destDir) }),
      })
    }

    const onUp = (upEvent: PointerEvent) => {
      const session = explorerDragRef.current
      clearListeners()
      explorerDragRef.current = null
      setDraggingPaths(new Set())
      setDragOverPath(null)
      setDragGhost(null)
      if (!session || upEvent.pointerId !== session.pointerId || !session.active) {
        window.setTimeout(() => {
          suppressTreeClickRef.current = false
        }, 0)
        return
      }

      const target = resolveExplorerDropFromPoint(upEvent.clientX, upEvent.clientY)
      window.setTimeout(() => {
        suppressTreeClickRef.current = false
      }, 0)
      if (!target || session.paths.some(p => pathsEqual(p, target.path))) return
      const destDir = target.isDir ? target.path : parentPath(target.path)
      void moveExplorerPaths(session.paths, destDir)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
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
    queueMicrotask(() => void startCreateEntry(project.path, false, project.id))
    // Consume once per pending flag; startCreateEntry uses latest project state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNewFile])

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
      pruneTreePaths([node.path])
      await refreshDirectory(parentPath(node.path))
      useProjectStore.getState().pushToast('success', t('已删除: {name}', { name: node.name }))
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const showEntryProperties = (path: string, name: string, isDir: boolean) => {
    void showPropertiesDialog(path, name, isDir)
  }

  const revealNode = async (node: FileNode) => {
    try {
      if (node.is_dir) await openPath(node.path)
      else await revealItemInDir(node.path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('在文件管理器中打开失败: {error}', { error: String(e) }))
    }
  }

  function contextMenuItems(target: ContextTarget): ContextMenuItem[] {
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
          label: t('粘贴'),
          icon: <ClipboardPaste size={14} />,
          shortcut: 'Ctrl+V',
          disabled: unavailable || !clipboard,
          action: () => void pasteExplorerClipboard(project.path),
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
          label: t('复制相对路径'),
          icon: <Copy size={14} />,
          shortcut: COPY_RELATIVE_PATH_SHORTCUT,
          action: () => void copyRelativePathAction(project.path),
        },
        {
          label: t('复制为文件引用'),
          icon: <AtSign size={14} />,
          shortcut: 'Alt+C',
          action: () => copyAsReference(project.path),
        },
        {
          label: t('显示属性'),
          icon: <Info size={14} />,
          separatorBefore: true,
          action: () => showEntryProperties(project.path, project.name, true),
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
        label: t('剪切'),
        icon: <Scissors size={14} />,
        shortcut: 'Ctrl+X',
        separatorBefore: true,
        action: () => cutExplorerPaths(node.path),
      },
      {
        label: t('复制'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+C',
        action: () => copyExplorerPaths(node.path),
      },
      {
        label: t('复制文件到剪贴板'),
        icon: <ClipboardCopy size={14} />,
        action: () => void copyFilesToSystemClipboard(node.path),
      },
      {
        label: t('粘贴'),
        icon: <ClipboardPaste size={14} />,
        shortcut: 'Ctrl+V',
        disabled: !clipboard,
        action: () => void pasteExplorerClipboard(node.is_dir ? node.path : parent),
      },
      {
        label: t('重命名'),
        icon: <Pencil size={14} />,
        ...(isShortcutBound(renameShortcut) ? { shortcut: renameShortcut } : {}),
        separatorBefore: true,
        action: () => startInlineRename(node),
      },
      {
        label: t('复制路径'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        action: () => copyPath(node.path),
      },
      {
        label: t('复制相对路径'),
        icon: <Copy size={14} />,
        shortcut: COPY_RELATIVE_PATH_SHORTCUT,
        action: () => void copyRelativePathAction(node.path),
      },
      {
        label: t('复制为文件引用'),
        icon: <AtSign size={14} />,
        shortcut: 'Alt+C',
        action: () => copyAsReference(node.path),
      },
      {
        label: t('显示属性'),
        icon: <Info size={14} />,
        separatorBefore: true,
        action: () => showEntryProperties(node.path, node.name, node.is_dir),
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

  const handleExplorerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (pendingRename || pendingCreate) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase()
        if (key === 'x') {
          event.preventDefault()
          cutExplorerPaths()
          return
        }
        if (key === 'c' && !event.shiftKey) {
          event.preventDefault()
          copyExplorerPaths()
          return
        }
        if (key === 'v') {
          event.preventDefault()
          void pasteExplorerClipboard()
          return
        }
      }
      if (selectedPath && shortcutMatchesEvent('Ctrl+Shift+C', event.nativeEvent)) {
        event.preventDefault()
        void copyPath(selectedPath)
        return
      }
      if (selectedPath && shortcutMatchesEvent(COPY_RELATIVE_PATH_SHORTCUT, event.nativeEvent)) {
        event.preventDefault()
        void copyRelativePathAction(selectedPath)
        return
      }
      if (selectedPath && shortcutMatchesEvent('Alt+C', event.nativeEvent)) {
        event.preventDefault()
        void copyAsReference(selectedPath)
        return
      }
      if (selectedPath && shortcutMatchesEvent(renameShortcut, event.nativeEvent)) {
        const node = findNodeByPath(tree, selectedPath)
        if (!node) return
        event.preventDefault()
        startInlineRename(node)
        return
      }
    handleTreeKeyDown(event)
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
        <span className="flex items-center gap-2">
          <FolderOpen size={13} className="text-brand" />
          {t('资源管理器')}
        </span>
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
                  data-explorer-drop={currentProject.path}
                  data-explorer-isdir="1"
                  className={`group flex items-center gap-1 pl-3 pr-2 py-[5px] text-[13px] select-none cursor-default [&_button]:cursor-default ${
                    dragOverPath != null && pathsEqual(dragOverPath, currentProject.path)
                      ? 'text-accent font-medium'
                      : isProjectRootSelected
                        ? 'bg-bg-active text-brand'
                        : 'text-tree-fg'
                  }`}
                  style={
                    dragOverPath != null && pathsEqual(dragOverPath, currentProject.path)
                      ? {
                          boxShadow: 'inset 3px 0 0 var(--color-accent)',
                          background:
                            'color-mix(in srgb, var(--color-accent) 28%, transparent)',
                        }
                      : undefined
                  }
                  onClick={() => replaceSelection(currentProject.path)}
                  onContextMenu={event => {
                    replaceSelection(currentProject.path)
                    showContextMenu(event, { kind: 'project', project: currentProject })
                  }}
                >
                  {unavailable ? (
                    <AlertTriangle size={15} className="text-warn flex-shrink-0" />
                  ) : (
                    <FolderOpen size={15} className="text-brand flex-shrink-0" />
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
                    <>
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
                      <Tooltip label={t('移除项目')} side="bottom">
                        <button
                          type="button"
                          aria-label={t('移除项目')}
                          className="p-0.5 text-fg-dim hover:text-danger"
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
                    </>
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
                        <div
                          ref={treeFocusRef}
                          tabIndex={0}
                          data-qingcode-explorer=""
                          className="flex-1 min-h-0 outline-none"
                          onKeyDown={handleExplorerKeyDown}
                        >
                          <List
                            listRef={listRef}
                            rowComponent={ExplorerTreeRow}
                            rowCount={visibleTreeRows.length}
                            rowHeight={index => {
                              const kind = visibleTreeRows[index]?.kind
                              return kind === 'create' || kind === 'rename' ? 30 : 26
                            }}
                            /* eslint-disable react-hooks/refs -- react-window invokes these callbacks after render. */
                            rowProps={{
                              rows: visibleTreeRows,
                              expandedPaths,
                              loadingPaths,
                              selectedPaths,
                              cutPaths,
                              dragOverPath,
                              draggingPaths,
                              gitStatusFor,
                              onOpenContextMenu: showContextMenu,
                              onCopyPath: copyPath,
                              onCopyRelativePath: path => void copyRelativePathAction(path),
                              onCopyAsReference: path => void copyAsReference(path),
                              onSelectNode: selectTreeNode,
                              onOpenNode: openTreeNode,
                              onToggleFolder: node => void toggleFolderExpand(node),
                              onCommitCreate: name => void commitCreate(name),
                              onCancelCreate: cancelCreate,
                              onCommitRename: name => void commitRename(name),
                              onCancelRename: cancelRename,
                              onPointerDownNode: handlePointerDownNode,
                            }}
                            /* eslint-enable react-hooks/refs */
                            overscanCount={12}
                            className="h-full"
                            style={{ width: '100%' }}
                          />
                        </div>
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
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {dragGhost &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[300] max-w-[240px] truncate rounded border border-accent bg-bg-elevated px-2.5 py-1 text-[12px] font-medium text-accent shadow-lg shadow-black/50"
            style={{ left: dragGhost.x + 14, top: dragGhost.y + 14 }}
          >
            {dragGhost.label}
          </div>,
          document.body,
        )}
    </div>
  )
}
