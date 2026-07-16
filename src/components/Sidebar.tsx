import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
  Terminal as TerminalIcon,
  Search as SearchIcon,
  AtSign,
} from 'lucide-react'
import Tooltip from './Tooltip'
import { useProjectStore, FileNode } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { safeInvoke } from '../lib/tauri'
import { confirmDialog } from '../store/confirmStore'
import { promptDialog, validateEntryName } from '../store/promptStore'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import InlineCreateRow from './InlineCreateRow'
import type { Project } from '../types'
import { collectAncestorDirs, copyToClipboard, formatFileReference, isDescendantOf, normalizePath, pathsEqual } from '../utils/fileReferences'
import { removeProjectWithConfirm, relocateProjectWithDialog, addTerminalProjectWithPrompt, renameProjectWithPrompt } from '../utils/projectActions'

type PendingCreate = {
  projectId: string
  parentPath: string
  directory: boolean
  depth: number
}

function createTreeDepth(parentPath: string, projectPath: string): number {
  const root = normalizePath(projectPath)
  const parent = normalizePath(parentPath)
  if (parent.toLowerCase() === root.toLowerCase()) return 1
  const rel = parent.slice(root.length).replace(/^\/+/, '')
  return rel.split('/').filter(Boolean).length + 1
}

function dirsToReveal(parentPath: string, projectPath: string): string[] {
  const root = normalizePath(projectPath)
  const parent = normalizePath(parentPath)
  if (parent.toLowerCase() === root.toLowerCase()) return []
  return collectAncestorDirs(`${parent}/.placeholder`, projectPath)
}

type ContextTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'node'; node: FileNode }
  | { kind: 'empty' }

function parentPath(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 ? path.slice(0, separator) : path
}

function FileTreeItem({
  node,
  depth,
  projectId,
  onOpenContextMenu,
  onCopyPath,
  pendingCreate,
  forceExpandedPaths,
  onCommitCreate,
  onCancelCreate,
}: {
  node: FileNode
  depth: number
  projectId: string
  onOpenContextMenu: (event: ReactMouseEvent, target: ContextTarget) => void
  onCopyPath: (path: string) => void
  pendingCreate: PendingCreate | null
  forceExpandedPaths: Set<string> | null
  onCommitCreate: (name: string) => void
  onCancelCreate: () => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const openFile = useEditorStore(s => s.openFile)
  const expandProjectDir = useProjectStore(s => s.expandProjectDir)
  const treeRevealPath = useProjectStore(s => s.treeRevealPath)
  const activeFilePath = useEditorStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId)
    return tab?.path ?? null
  })
  const isActive = !node.is_dir && activeFilePath != null && pathsEqual(node.path, activeFilePath)

  useEffect(() => {
    if (!node.is_dir || !treeRevealPath) return
    if (isDescendantOf(treeRevealPath, node.path)) {
      setExpanded(true)
    }
  }, [treeRevealPath, node.path, node.is_dir])

  useEffect(() => {
    if (!isActive || !rowRef.current) return
    rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [isActive, treeRevealPath])

  useEffect(() => {
    if (forceExpandedPaths?.has(node.path)) setExpanded(true)
  }, [forceExpandedPaths, node.path])

  useEffect(() => {
    if (pendingCreate?.parentPath === node.path && node.is_dir) setExpanded(true)
  }, [pendingCreate, node.path, node.is_dir])

  const toggle = async () => {
    if (!node.is_dir) {
      openFile(node.path)
      return
    }
    const next = !expanded
    setExpanded(next)
    if (next && !node.loaded) {
      setLoading(true)
      await expandProjectDir(projectId, node.path)
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!expanded || !node.is_dir || node.loaded || loading) return
    setLoading(true)
    expandProjectDir(projectId, node.path).finally(() => setLoading(false))
  }, [expandProjectDir, expanded, loading, node.is_dir, node.loaded, node.path, projectId])

  const pad = depth * 12 + 8

  return (
    <div>
      <div
        ref={rowRef}
        tabIndex={0}
        className={`flex items-center gap-1 pr-2 py-[3px] cursor-pointer text-[13px] select-none focus:outline-none
          ${isActive ? 'bg-bg-active text-accent' : 'hover:bg-bg-hover focus:bg-bg-active'}`}
        style={{ paddingLeft: pad }}
        onClick={toggle}
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
            {expanded ? (
              <ChevronDown size={14} className="text-fg-dim flex-shrink-0" />
            ) : (
              <ChevronRight size={14} className="text-fg-dim flex-shrink-0" />
            )}
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
        <span className="truncate text-fg">{node.name}</span>
        {loading && <RefreshCw size={12} className="ml-auto text-fg-dim animate-spin" />}
      </div>
      {expanded && node.is_dir && (
        <>
          {pendingCreate?.parentPath === node.path && (
            <InlineCreateRow
              directory={pendingCreate.directory}
              depth={depth + 1}
              onSubmit={onCommitCreate}
              onCancel={onCancelCreate}
            />
          )}
          {node.loaded &&
            node.children?.map(child => (
              <FileTreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                projectId={projectId}
                onOpenContextMenu={onOpenContextMenu}
                onCopyPath={onCopyPath}
                pendingCreate={pendingCreate}
                forceExpandedPaths={forceExpandedPaths}
                onCommitCreate={onCommitCreate}
                onCancelCreate={onCancelCreate}
              />
            ))}
        </>
      )}
    </div>
  )
}

export default function Sidebar() {
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
  const activeTabPath = useEditorStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId)
    return tab?.path ?? null
  })
  const setView = useUIStore(s => s.setView)
  const addTerminal = useTerminalStore(s => s.addTerminal)
  const requestSearch = useUIStore(s => s.requestSearch)
  const renameEditorPath = useEditorStore(s => s.renamePath)
  const closeTabsForPath = useEditorStore(s => s.closeTabsForPath)
  const [refreshing, setRefreshing] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    target: ContextTarget
  } | null>(null)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)

  const forceExpandedPaths = useMemo(() => {
    if (!pendingCreate) return null
    const project = projects.find(p => p.id === pendingCreate.projectId)
    if (!project) return null
    return new Set(dirsToReveal(pendingCreate.parentPath, project.path))
  }, [pendingCreate, projects])

  const handleLocateActiveFile = () => {
    if (!activeTabPath) return
    setView('explorer')
    void revealFileInTree(activeTabPath)
  }

  const handleRefresh = async () => {
    if (refreshing || !currentProject) return
    setRefreshing(true)
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

  const handleRemoveProject = (id: string, name: string, path: string) => {
    void removeProjectWithConfirm(id, name, path)
  }

  const handleRelocateProject = (id: string) => {
    void relocateProjectWithDialog(id)
  }

  const handleOpenProject = async (path: string) => {
    try {
      await openPath(path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', `打开项目目录失败: ${String(e)}`)
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
      useProjectStore.getState().pushToast('success', '路径已复制')
    } catch (e) {
      useProjectStore.getState().pushToast('error', `复制路径失败: ${String(e)}`)
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
      useProjectStore.getState().pushToast('error', '无法确定该路径所属项目')
      return
    }
    try {
      const ref = formatFileReference(project, path, 1)
      await copyToClipboard(ref)
      useProjectStore.getState().pushToast('success', '文件引用已复制')
    } catch (e) {
      useProjectStore.getState().pushToast('error', `复制引用失败: ${String(e)}`)
    }
  }

  const openTerminalHere = async (cwd: string) => {
    const project = projectOfPath(cwd)
    if (!project) {
      useProjectStore.getState().pushToast('error', '无法确定该目录所属项目')
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
    const label = directory ? '文件夹' : '文件'
    setPendingCreate(null)
    try {
      const path = await safeInvoke<string>(
        `新建${label}`,
        directory ? 'create_directory' : 'create_file',
        { parent: parentPath, name }
      )
      await refreshDirectory(parentPath)
      useProjectStore.getState().pushToast('success', `已新建${label}: ${name}`)
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

  const handleRenameNode = async (node: FileNode) => {
    const name = await promptDialog({
      title: '重命名',
      message: node.is_dir ? '文件夹新名称' : '文件新名称',
      defaultValue: node.name,
      validate: validateEntryName,
      confirmLabel: '重命名',
    })
    if (!name || name === node.name) return
    try {
      const newPath = await safeInvoke<string>('重命名', 'rename_path', {
        path: node.path,
        newName: name,
      })
      renameEditorPath(node.path, newPath)
      await refreshDirectory(parentPath(node.path))
      useProjectStore.getState().pushToast('success', `已重命名为: ${name}`)
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const handleDeleteNode = async (node: FileNode) => {
    const confirmed = await confirmDialog({
      title: '永久删除',
      message: `确定永久删除${node.is_dir ? '文件夹' : '文件'}「${node.name}」？`,
      detail: node.is_dir
        ? '文件夹内的全部内容都会被删除，且无法撤销。'
        : '此操作无法撤销。',
      kind: 'danger',
      confirmLabel: '删除',
      cancelLabel: '取消',
    })
    if (!confirmed) return
    try {
      await safeInvoke('删除', 'delete_path', { path: node.path })
      closeTabsForPath(node.path)
      await refreshDirectory(parentPath(node.path))
      useProjectStore.getState().pushToast('success', `已删除: ${node.name}`)
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const revealNode = async (node: FileNode) => {
    try {
      if (node.is_dir) await openPath(node.path)
      else await revealItemInDir(node.path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', `在文件管理器中打开失败: ${String(e)}`)
    }
  }

  const contextMenuItems = (target: ContextTarget): ContextMenuItem[] => {
    if (target.kind === 'empty') {
      return [
        {
          label: '添加文件夹项目',
          icon: <FolderPlus size={14} />,
          action: handleAddProject,
        },
        {
          label: '新建终端项目',
          icon: <TerminalIcon size={14} />,
          action: () => addTerminalProjectWithPrompt(),
        },
        {
          label: '刷新',
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
          label: currentProject?.id === project.id ? '当前项目' : '切换到此项目',
          icon: <FolderOpen size={14} />,
          disabled: currentProject?.id === project.id || unavailable,
          action: () => switchProject(project),
        },
        {
          label: '新建终端',
          icon: <TerminalIcon size={14} />,
          disabled: unavailable,
          action: () => addTerminal(project.path, project.id),
        },
        {
          label: '在此项目内搜索',
          icon: <SearchIcon size={14} />,
          disabled: unavailable,
          action: () => requestSearch(project.path),
        },
        {
          label: '新建文件',
          icon: <FilePlus size={14} />,
          separatorBefore: true,
          disabled: unavailable,
          action: () => activateThen(() => startCreateEntry(project.path, false, project.id)),
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus size={14} />,
          disabled: unavailable,
          action: () => activateThen(() => startCreateEntry(project.path, true, project.id)),
        },
        {
          label: '刷新项目',
          icon: <RefreshCw size={14} />,
          disabled: unavailable,
          separatorBefore: true,
          action: () => activateThen(() => refreshProjectTree(project)),
        },
        {
          label: '在文件管理器中打开',
          icon: <ExternalLink size={14} />,
          disabled: unavailable,
          action: () => handleOpenProject(project.path),
        },
        {
          label: '复制路径',
          icon: <Copy size={14} />,
          shortcut: 'Ctrl+Shift+C',
          action: () => copyPath(project.path),
        },
        {
          label: '复制为文件引用',
          icon: <AtSign size={14} />,
          action: () => copyAsReference(project.path),
        },
        {
          label: '重命名项目',
          icon: <Pencil size={14} />,
          separatorBefore: true,
          action: () => renameProjectWithPrompt(project.id, project.name),
        },
        {
          label: '重新定位项目',
          icon: <LocateFixed size={14} />,
          action: () => handleRelocateProject(project.id),
        },
        {
          label: '移除项目',
          icon: <Trash2 size={14} />,
          danger: true,
          action: () => handleRemoveProject(project.id, project.name, project.path),
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
              label: '打开文件',
              icon: <FileIcon size={14} />,
              action: () => useEditorStore.getState().openFile(node.path),
            },
            {
              label: '新建文件（同目录）',
              icon: <FilePlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(parent, false, project.id),
            },
            {
              label: '新建文件夹（同目录）',
              icon: <FolderPlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(parent, true, project.id),
            },
          ]
        : [
            {
              label: '新建文件',
              icon: <FilePlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(node.path, false, project.id),
            },
            {
              label: '新建文件夹',
              icon: <FolderPlus size={14} />,
              disabled: !project,
              action: () => project && startCreateEntry(node.path, true, project.id),
            },
            {
              label: '在此处打开终端',
              icon: <TerminalIcon size={14} />,
              separatorBefore: true,
              action: () => openTerminalHere(node.path),
            },
            {
              label: '在此文件夹中搜索',
              icon: <SearchIcon size={14} />,
              action: () => requestSearch(node.path),
            },
          ]),
      {
        label: '重命名',
        icon: <Pencil size={14} />,
        separatorBefore: true,
        action: () => handleRenameNode(node),
      },
      {
        label: '复制路径',
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        action: () => copyPath(node.path),
      },
      {
        label: '复制为文件引用',
        icon: <AtSign size={14} />,
        action: () => copyAsReference(node.path),
      },
      {
        label: node.is_dir ? '在文件管理器中打开' : '在文件管理器中显示',
        icon: <ExternalLink size={14} />,
        action: () => revealNode(node),
      },
      {
        label: '永久删除',
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
        <span>资源管理器</span>
        <div className="flex items-center gap-0.5">
          <Tooltip label="在侧边栏定位当前文件" side="bottom">
            <button
              type="button"
              onClick={handleLocateActiveFile}
              disabled={!activeTabPath}
              aria-label="在侧边栏定位当前文件"
              className={`p-1 rounded transition-colors flex-shrink-0
              ${!activeTabPath
                ? 'opacity-40'
                : 'text-fg-dim hover:text-fg hover:bg-bg-hover'}`}
            >
              <LocateFixed size={13} />
            </button>
          </Tooltip>
          <Tooltip label="刷新" side="bottom">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing || !currentProject}
              aria-label="刷新"
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
      <div className="flex-1 overflow-auto pb-3">
        {!currentProject ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[13px] text-fg-muted mb-3">No project opened</p>
            <button
              onClick={handleAddProject}
              className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded bg-bg-elevated hover:bg-bg-active border border-border-strong text-fg"
            >
              <Plus size={14} /> Add project
            </button>
          </div>
        ) : (
          (() => {
            const unavailable = unavailableProjectIds.includes(currentProject.id)
            const tree = projectTrees[currentProject.id] ?? []
            return (
              <>
                <div
                  className="group flex items-center gap-1 pr-2 py-[5px] text-[13px] select-none text-fg cursor-default"
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
                  <Tooltip label="新建文件" side="bottom">
                    <button
                      type="button"
                      aria-label="新建文件"
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void startCreateEntry(currentProject.path, false, currentProject.id)
                      }}
                    >
                      <FilePlus size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label="新建文件夹" side="bottom">
                    <button
                      type="button"
                      aria-label="新建文件夹"
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void startCreateEntry(currentProject.path, true, currentProject.id)
                      }}
                    >
                      <FolderPlus size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label="新建终端" side="bottom">
                    <button
                      type="button"
                      aria-label="新建终端"
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void addTerminal(currentProject.path, currentProject.id)
                      }}
                    >
                      <TerminalIcon size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label="在文件管理器中打开" side="bottom">
                    <button
                      type="button"
                      aria-label="在文件管理器中打开"
                      disabled={unavailable}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-fg-dim hover:text-fg disabled:opacity-0 disabled:cursor-not-allowed"
                      onClick={event => {
                        event.stopPropagation()
                        void handleOpenProject(currentProject.path)
                      }}
                    >
                      <ExternalLink size={13} />
                    </button>
                  </Tooltip>
                  {unavailable ? (
                    <Tooltip label="重新定位项目" side="bottom">
                      <button
                        type="button"
                        aria-label="重新定位项目"
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
                    <Tooltip label="移除项目" side="bottom">
                      <button
                        type="button"
                        aria-label="移除项目"
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-fg-dim hover:text-danger"
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
                  onContextMenu={event =>
                    showContextMenu(event, { kind: 'project', project: currentProject })
                  }
                >
                  {unavailable ? (
                    <div className="px-4 py-2 text-[12px] text-warn flex items-center gap-1.5">
                      <AlertTriangle size={12} /> 目录不可用，请重新定位
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
                          <div className="px-4 py-2 text-[12px] text-fg-muted">Empty folder</div>
                        )}
                      {tree.map(node => (
                        <FileTreeItem
                          key={node.path}
                          node={node}
                          depth={1}
                          projectId={currentProject.id}
                          onOpenContextMenu={showContextMenu}
                          onCopyPath={copyPath}
                          pendingCreate={pendingCreate}
                          forceExpandedPaths={forceExpandedPaths}
                          onCommitCreate={name => void commitCreate(name)}
                          onCancelCreate={cancelCreate}
                        />
                      ))}
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
