/**
 * Save / activate / delete named multi-project workspaces.
 * Coordinates projectStore + editor/terminal session restore.
 */

import { confirmDialog } from '../store/confirmStore'
import { promptDialog, validateEntryName } from '../store/promptStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { translate } from './i18n'
import { setEditorScroll } from './editorSession'
import {
  buildNamedWorkspace,
  DEFAULT_NAMED_WORKSPACE_NAME,
  formatNamedWorkspaceName,
  loadNamedWorkspaceCatalog,
  normalizeNamedWorkspaceName,
  remapWorkspaceSessions,
  removeNamedWorkspace,
  saveNamedWorkspaceCatalog,
  setActiveNamedWorkspaceId,
  upsertNamedWorkspace,
  type NamedWorkspace,
  type ProjectLike,
} from './namedWorkspacePersist'
import {
  captureWorkspaceSessionSnapshot,
  flushWorkspaceSessionPersist,
  projectSessionFromPersisted,
  terminalFromPersisted,
} from './workspaceSessionSync'
import type { PersistedProjectSession } from './workspaceSessionPersist'

function applyScrollFromSessions(sessions: Record<string, PersistedProjectSession>) {
  for (const session of Object.values(sessions)) {
    for (const tab of session.tabs) {
      if (tab.scroll) setEditorScroll(tab.id, tab.scroll)
    }
  }
}

function listDurableVisibleProjects(): ProjectLike[] {
  return useProjectStore
    .getState()
    .projects.filter(p => !p.ephemeral && !p.hidden)
}

function listDurableProjectsByIds(ids: Iterable<string>): ProjectLike[] {
  const want = new Set(ids)
  return useProjectStore
    .getState()
    .projects.filter(p => !p.ephemeral && want.has(p.id))
}

/** Persist catalog + toast helper. */
function commitCatalog(
  mutator: (catalog: ReturnType<typeof loadNamedWorkspaceCatalog>) => ReturnType<
    typeof loadNamedWorkspaceCatalog
  >,
) {
  const next = mutator(loadNamedWorkspaceCatalog())
  saveNamedWorkspaceCatalog(next)
  return next
}

export function listNamedWorkspaces(): NamedWorkspace[] {
  return loadNamedWorkspaceCatalog().workspaces
}

export function getActiveNamedWorkspaceId(): string | null {
  return loadNamedWorkspaceCatalog().activeWorkspaceId
}

/** Prompt and save currently visible durable projects as a named workspace. */
export async function saveVisibleProjectsAsWorkspace(): Promise<NamedWorkspace | null> {
  const projects = listDurableVisibleProjects()
  if (projects.length === 0) {
    useProjectStore
      .getState()
      .pushToast('info', translate('请先在顶栏显示至少一个项目，再保存为多项目工作区'))
    return null
  }
  const name = await promptDialog({
    title: translate('保存为多项目工作区'),
    message: translate('工作区名称'),
    defaultValue: translate(DEFAULT_NAMED_WORKSPACE_NAME),
    confirmLabel: translate('保存'),
    validate: validateEntryName,
  })
  if (!name) return null
  return saveProjectsAsWorkspace(
    projects.map(p => p.id),
    normalizeNamedWorkspaceName(name),
  )
}

/** Save specific durable projects (e.g. Project Manager selection). */
export async function saveProjectsAsWorkspace(
  projectIds: string[],
  name: string,
  options?: { workspaceId?: string },
): Promise<NamedWorkspace | null> {
  const projects = listDurableProjectsByIds(projectIds)
  if (projects.length === 0) {
    useProjectStore.getState().pushToast('info', translate('没有可保存的项目'))
    return null
  }

  const storedName = normalizeNamedWorkspaceName(name)
  flushWorkspaceSessionPersist()
  const snapshot = captureWorkspaceSessionSnapshot({ projectIds: projects.map(p => p.id) })
  const existing = options?.workspaceId
    ? loadNamedWorkspaceCatalog().workspaces.find(w => w.id === options.workspaceId)
    : undefined
  const workspace = buildNamedWorkspace({
    id: existing?.id,
    name: storedName,
    projects,
    snapshot,
    activeProjectId: useProjectStore.getState().currentProject?.id ?? null,
  })
  if (!workspace) {
    useProjectStore.getState().pushToast('error', translate('保存多项目工作区失败'))
    return null
  }
  if (existing) {
    workspace.createdAt = existing.createdAt
  }

  commitCatalog(catalog => upsertNamedWorkspace(catalog, workspace))
  useProjectStore
    .getState()
    .pushToast(
      'success',
      translate('已保存多项目工作区「{name}」', {
        name: formatNamedWorkspaceName(workspace.name, translate),
      }),
    )
  return workspace
}

/** Re-capture sessions for an existing workspace from its current members (if still present). */
export async function updateNamedWorkspaceSessions(
  workspaceId: string,
): Promise<NamedWorkspace | null> {
  const catalog = loadNamedWorkspaceCatalog()
  const existing = catalog.workspaces.find(w => w.id === workspaceId)
  if (!existing) {
    useProjectStore.getState().pushToast('error', translate('找不到该多项目工作区'))
    return null
  }
  const remapped = remapWorkspaceSessions(existing, useProjectStore.getState().projects)
  if (remapped.resolved.length === 0) {
    useProjectStore
      .getState()
      .pushToast('error', translate('工作区中的项目均不可用，无法更新会话'))
    return null
  }
  return saveProjectsAsWorkspace(
    remapped.resolved.map(r => r.project.id),
    existing.name,
    { workspaceId: existing.id },
  )
}

export async function renameNamedWorkspace(workspaceId: string): Promise<boolean> {
  const existing = loadNamedWorkspaceCatalog().workspaces.find(w => w.id === workspaceId)
  if (!existing) return false
  const name = await promptDialog({
    title: translate('重命名多项目工作区'),
    message: translate('工作区名称'),
    defaultValue: formatNamedWorkspaceName(existing.name, translate),
    confirmLabel: translate('重命名'),
    validate: validateEntryName,
  })
  if (!name) return false
  const storedName = normalizeNamedWorkspaceName(name)
  if (storedName === existing.name) return false
  const updated: NamedWorkspace = {
    ...existing,
    name: storedName,
    updatedAt: Date.now(),
  }
  commitCatalog(catalog => upsertNamedWorkspace(catalog, updated))
  useProjectStore
    .getState()
    .pushToast(
      'success',
      translate('已重命名为「{name}」', {
        name: formatNamedWorkspaceName(updated.name, translate),
      }),
    )
  return true
}

export async function deleteNamedWorkspace(workspaceId: string): Promise<boolean> {
  const existing = loadNamedWorkspaceCatalog().workspaces.find(w => w.id === workspaceId)
  if (!existing) return false
  const ok = await confirmDialog({
    title: translate('删除多项目工作区'),
    message: translate('确定删除多项目工作区「{name}」？', {
      name: formatNamedWorkspaceName(existing.name, translate),
    }),
    detail: translate('仅删除工作区快照，不会移除项目或磁盘文件。'),
    kind: 'danger',
    confirmLabel: translate('删除'),
    cancelLabel: translate('取消'),
  })
  if (!ok) return false
  commitCatalog(catalog => removeNamedWorkspace(catalog, workspaceId))
  useProjectStore
    .getState()
    .pushToast(
      'info',
      translate('已删除多项目工作区「{name}」', {
        name: formatNamedWorkspaceName(existing.name, translate),
      }),
    )
  return true
}

/**
 * Activate a named workspace: unhide members, restore editor/terminal sessions,
 * switch to the saved active project.
 */
export async function activateNamedWorkspace(workspaceId: string): Promise<boolean> {
  const catalog = loadNamedWorkspaceCatalog()
  const workspace = catalog.workspaces.find(w => w.id === workspaceId)
  if (!workspace) {
    useProjectStore.getState().pushToast('error', translate('找不到该多项目工作区'))
    return false
  }

  flushWorkspaceSessionPersist()

  const projects = useProjectStore.getState().projects
  const remapped = remapWorkspaceSessions(workspace, projects)
  if (remapped.resolved.length === 0) {
    useProjectStore
      .getState()
      .pushToast('error', translate('工作区中的项目均不可用，请先重新定位或添加项目'))
    return false
  }

  const projectStore = useProjectStore.getState()
  for (const { project } of remapped.resolved) {
    if (project.hidden) {
      await projectStore.unhideProject(project.id)
    }
  }

  // Disk-missing folders stay in the project list but are marked unavailable.
  const unavailableIds = new Set(useProjectStore.getState().unavailableProjectIds)
  const availableResolved = remapped.resolved.filter(r => !unavailableIds.has(r.project.id))
  const diskUnavailableCount = remapped.resolved.length - availableResolved.length
  const missingCount = remapped.missing.length

  applyScrollFromSessions(remapped.sessionsByProjectId)

  const editorSessions = Object.fromEntries(
    Object.entries(remapped.sessionsByProjectId).map(([projectId, session]) => [
      projectId,
      projectSessionFromPersisted(session),
    ]),
  )

  const memberIds = remapped.resolved.map(r => r.project.id)
  const terminals = []
  const activeTerminalByProject: Record<string, string> = {}
  for (const [projectId, session] of Object.entries(remapped.sessionsByProjectId)) {
    for (const terminal of session.terminals) {
      terminals.push(terminalFromPersisted(projectId, terminal))
    }
    if (session.activeTerminalId) {
      activeTerminalByProject[projectId] = session.activeTerminalId
    }
  }
  await useTerminalStore
    .getState()
    .replaceTerminalSessionsForProjects(memberIds, terminals, activeTerminalByProject)

  // Prefer a project whose directory still exists on disk.
  let activeId = remapped.activeProjectId
  if (activeId && unavailableIds.has(activeId)) {
    activeId = availableResolved[0]?.project.id ?? null
  } else if (!activeId) {
    activeId = availableResolved[0]?.project.id ?? remapped.activeProjectId
  }

  const currentId = useProjectStore.getState().currentProject?.id ?? null

  if (activeId && activeId === currentId && editorSessions[activeId]) {
    const visible = editorSessions[activeId]
    const stash = { ...editorSessions }
    delete stash[activeId]
    useEditorStore.getState().mergeProjectSessions(stash)
    useEditorStore.getState().applyVisibleProjectSession(visible)
    useTerminalStore.getState().activateProject(activeId)
  } else {
    // switchProject pulls the target session out of projectSessions into visible tabs.
    useEditorStore.getState().mergeProjectSessions(editorSessions)
    if (activeId) {
      const target = useProjectStore.getState().projects.find(p => p.id === activeId)
      if (target) {
        const switched = await useProjectStore.getState().switchProject(target)
        if (!switched) {
          useProjectStore
            .getState()
            .pushToast('error', translate('打开多项目工作区失败：无法切换到目标项目'))
          return false
        }
      }
    }
    // If every member directory is gone, chips stay visible with ⚠ for relocate.
  }

  // Expand member rows in the explorer.
  useProjectStore.setState(s => {
    const expandedProjects = { ...s.expandedProjects }
    for (const id of memberIds) expandedProjects[id] = true
    return { expandedProjects }
  })

  commitCatalog(c => setActiveNamedWorkspaceId(c, workspace.id))
  useUIStore.getState().setView('explorer')

  if (diskUnavailableCount > 0 || missingCount > 0) {
    const details: string[] = []
    if (diskUnavailableCount > 0) {
      details.push(
        translate('{count} 个项目目录不可用', { count: diskUnavailableCount }),
      )
    }
    if (missingCount > 0) {
      details.push(translate('{count} 个项目已不在列表中', { count: missingCount }))
    }
    useProjectStore.getState().pushToast(
      availableResolved.length > 0 ? 'info' : 'error',
      translate('已打开多项目工作区「{name}」（{detail}，请重新定位）', {
        name: formatNamedWorkspaceName(workspace.name, translate),
        detail: details.join(translate('、')),
      }),
    )
  } else {
    useProjectStore.getState().pushToast(
      'success',
      translate('已打开多项目工作区「{name}」', {
        name: formatNamedWorkspaceName(workspace.name, translate),
      }),
    )
  }
  return true
}

/** Prompt for a name and save the given project ids. */
export async function saveSelectedProjectsAsWorkspace(
  projectIds: string[],
): Promise<NamedWorkspace | null> {
  if (projectIds.length === 0) {
    useProjectStore.getState().pushToast('info', translate('请先选择要加入工作区的项目'))
    return null
  }
  const name = await promptDialog({
    title: translate('保存选中为多项目工作区'),
    message: translate('工作区名称'),
    defaultValue: translate(DEFAULT_NAMED_WORKSPACE_NAME),
    confirmLabel: translate('保存'),
    validate: validateEntryName,
  })
  if (!name) return null
  return saveProjectsAsWorkspace(projectIds, normalizeNamedWorkspaceName(name))
}
