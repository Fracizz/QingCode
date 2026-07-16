import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
import { isTauri, safeInvoke } from '../lib/tauri'
import { open } from '@tauri-apps/plugin-dialog'
import { confirmDialog } from '../store/confirmStore'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import type { Project } from '../types'
import { copyToClipboard, formatFileReference } from '../utils/fileReferences'

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
}: {
  node: FileNode
  depth: number
  projectId: string
  onOpenContextMenu: (event: ReactMouseEvent, target: ContextTarget) => void
  onCopyPath: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const openFile = useEditorStore(s => s.openFile)
  const expandProjectDir = useProjectStore(s => s.expandProjectDir)

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
        tabIndex={0}
        className="flex items-center gap-1 pr-2 py-[3px] cursor-pointer text-[13px] select-none hover:bg-bg-hover focus:bg-bg-active focus:outline-none"
        style={{ paddingLeft: pad }}
        onClick={toggle}
        onContextMenu={event => onOpenContextMenu(event, { kind: 'node', node })}
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
      {expanded && node.is_dir && node.loaded && node.children?.map(child => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          projectId={projectId}
          onOpenContextMenu={onOpenContextMenu}
          onCopyPath={onCopyPath}
        />
      ))}
    </div>
  )
}

export default function Sidebar() {
  const {
    projects,
    currentProject,
    projectTrees,
    expandedProjects,
    unavailableProjectIds,
    removeProject,
    relocateProject,
    switchProject,
    refreshProjectTree,
    toggleProjectExpanded,
    expandProjectDir,
  } = useProjectStore()
  const terminals = useTerminalStore(s => s.terminals)
  const closeProjectTerminals = useTerminalStore(s => s.closeProjectTerminals)
  const updateProjectPath = useTerminalStore(s => s.updateProjectPath)
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

  const handleRemoveProject = async (id: string, name: string, path: string) => {
    try {
      const projectTerminals = terminals.filter(terminal => terminal.projectId === id)
      const runningCount = projectTerminals.filter(terminal => terminal.status !== 'exited').length
      if (isTauri()) {
        const ok = await confirmDialog({
          title: '移除项目',
          message: `确定从工作区移除「${name}」？`,
          detail:
            runningCount > 0
              ? `该项目有 ${runningCount} 个运行中的终端，移除后将被终止。\n不会删除磁盘上的项目文件。`
              : '不会删除磁盘上的项目文件。',
          kind: 'warning',
          confirmLabel: '移除',
          cancelLabel: '取消',
        })
        if (!ok) return
      }
      await closeProjectTerminals(id)
      closeTabsForPath(path)
      await removeProject(id)
    } catch (e) {
      console.error('remove project failed:', e)
      useProjectStore.getState().pushToast('error', `移除项目失败: ${String(e)}`)
    }
  }

  const handleRelocateProject = async (id: string) => {
    try {
      const selected = await open({ directory: true, multiple: false })
      if (typeof selected === 'string' && (await relocateProject(id, selected))) {
        updateProjectPath(id, selected)
      }
    } catch (e) {
      useProjectStore.getState().pushToast('error', `重新定位项目失败: ${String(e)}`)
    }
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

  const createEntry = async (parent: string, directory: boolean) => {
    const label = directory ? '文件夹' : '文件'
    const name = window.prompt(`请输入${label}名称`)
    if (!name?.trim()) return
    try {
      const path = await safeInvoke<string>(
        `新建${label}`,
        directory ? 'create_directory' : 'create_file',
        { parent, name: name.trim() }
      )
      await refreshDirectory(parent)
      useProjectStore.getState().pushToast('success', `已新建${label}: ${name.trim()}`)
      if (!directory) await useEditorStore.getState().openFile(path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', `${String(e)}`)
    }
  }

  const handleRenameNode = async (node: FileNode) => {
    const name = window.prompt('请输入新名称', node.name)
    if (!name?.trim() || name.trim() === node.name) return
    try {
      const newPath = await safeInvoke<string>('重命名', 'rename_path', {
        path: node.path,
        newName: name.trim(),
      })
      renameEditorPath(node.path, newPath)
      await refreshDirectory(parentPath(node.path))
      useProjectStore.getState().pushToast('success', `已重命名为: ${name.trim()}`)
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
          label: '添加项目',
          icon: <FolderPlus size={14} />,
          action: handleAddProject,
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
          action: () => activateThen(() => createEntry(project.path, false)),
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus size={14} />,
          disabled: unavailable,
          action: () => activateThen(() => createEntry(project.path, true)),
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
          label: '重新定位项目',
          icon: <LocateFixed size={14} />,
          separatorBefore: true,
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
              action: () => createEntry(parent, false),
            },
            {
              label: '新建文件夹（同目录）',
              icon: <FolderPlus size={14} />,
              action: () => createEntry(parent, true),
            },
          ]
        : [
            {
              label: '新建文件',
              icon: <FilePlus size={14} />,
              action: () => createEntry(node.path, false),
            },
            {
              label: '新建文件夹',
              icon: <FolderPlus size={14} />,
              action: () => createEntry(node.path, true),
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

      {/* Multi-project list — every project is a root row, expanded by default */}
      <div className="flex-1 overflow-auto pb-3">
          {projects.length === 0 ? (
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
            projects.map(project => {
              const unavailable = unavailableProjectIds.includes(project.id)
              const expanded = expandedProjects[project.id] ?? true
              const isCurrent = currentProject?.id === project.id
              const tree = projectTrees[project.id] ?? []
              return (
                <div key={project.id}>
                  <div
                    tabIndex={0}
                    className={`group flex items-center gap-1 pr-2 py-[5px] cursor-pointer text-[13px] select-none
                      ${isCurrent ? 'bg-bg-active text-fg' : 'text-fg hover:bg-bg-hover'}`}
                    onClick={() => switchProject(project)}
                    onContextMenu={event => showContextMenu(event, { kind: 'project', project })}
                    onKeyDown={event => {
                      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
                        event.preventDefault()
                        void copyPath(project.path)
                      }
                    }}
                  >
                    <button
                      title={expanded ? '折叠' : '展开'}
                      className="flex items-center justify-center w-[18px] h-[18px] flex-shrink-0 text-fg-dim hover:text-fg"
                      onClick={e => {
                        e.stopPropagation()
                        toggleProjectExpanded(project.id)
                      }}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    {unavailable ? (
                      <AlertTriangle size={15} className="text-warn flex-shrink-0" />
                    ) : expanded ? (
                      <FolderOpen size={15} className="text-accent flex-shrink-0" />
                    ) : (
                      <Folder size={15} className="text-accent flex-shrink-0" />
                    )}
                    <span className="truncate flex-1 font-medium">{project.name}</span>
                    {!unavailable && (
                      <button
                        title="在文件管理器中打开"
                        className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-fg"
                        onClick={e => {
                          e.stopPropagation()
                          handleOpenProject(project.path)
                        }}
                      >
                        <ExternalLink size={13} />
                      </button>
                    )}
                    {unavailable && (
                      <button
                        title="重新定位项目"
                        className="text-warn hover:text-fg"
                        onClick={e => {
                          e.stopPropagation()
                          handleRelocateProject(project.id)
                        }}
                      >
                        <LocateFixed size={13} />
                      </button>
                    )}
                    <button
                      title="移除项目"
                      className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-danger"
                      onClick={e => {
                        e.stopPropagation()
                        handleRemoveProject(project.id, project.name, project.path)
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                  {expanded && (
                    <div onContextMenu={event => showContextMenu(event, { kind: 'project', project })}>
                      {unavailable ? (
                        <div className="px-4 py-2 text-[12px] text-warn flex items-center gap-1.5">
                          <AlertTriangle size={12} /> 目录不可用，请重新定位
                        </div>
                      ) : tree.length === 0 ? (
                        <div className="px-4 py-2 text-[12px] text-fg-muted">Empty folder</div>
                      ) : (
                        tree.map(node => (
                          <FileTreeItem
                            key={node.path}
                            node={node}
                            depth={1}
                            projectId={project.id}
                            onOpenContextMenu={showContextMenu}
                            onCopyPath={copyPath}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              )
            })
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
