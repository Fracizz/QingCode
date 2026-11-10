/** 把引擎接到应用的 store、IPC 和持久化上。 */
import { getGitRemotes, getGitStatus } from '@/lib/ipc/git'
import {
  fastForwardForPushSync,
  fetchForPushSync,
  setPushSyncWatches,
} from '@/lib/ipc/gitPushSync'
import { translate } from '@/lib/i18n'
import { countDirtyTabsByProject } from '@/lib/projectIndicators'
import { projectSourceLabel } from '@/lib/projectLabels'
import { withDb } from '@/lib/projectRepository'
import { syncOpenFilesOnFocus } from '@/lib/syncOpenFileFromDisk'
import { createDefaultSyncOpenFileDeps } from '@/lib/syncOpenFileFromDiskDeps'
import { isProjectTrusted } from '@/lib/workspaceTrust'
import { useEditorStore } from '@/store/editorStore'
import { useGitStatusStore } from '@/store/gitStatusStore'
import { useProjectStore } from '@/store/projectStore'
import type { EditorTab, Project } from '@/types'
import { isDescendantOf } from '@/utils/fileReferences'
import { parseConfig, type GitPushSyncConfig } from './core'
import { createGitPushSyncEngine, type SyncResult } from './engine'
import { useGitPushSyncStore } from './store'

/** 全部配置放在一个 key 里，功能移除时删除这一行即可。 */
const CONFIG_KEY = 'gitPushSync.config'

export async function loadConfig(): Promise<GitPushSyncConfig> {
  const rows = await withDb('读取 Git 多端同步设置', db =>
    db.select<{ value: string }[]>('SELECT value FROM settings WHERE key = $1', [CONFIG_KEY]),
  )
  const config = parseConfig(rows[0]?.value)
  useGitPushSyncStore.getState().setConfig(config)
  return config
}

export async function saveConfig(config: GitPushSyncConfig): Promise<void> {
  useGitPushSyncStore.getState().setConfig(config)
  await withDb('保存 Git 多端同步设置', db =>
    db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)', [
      CONFIG_KEY,
      JSON.stringify(config),
    ]),
  )
}

function listAllTabs(): EditorTab[] {
  const editor = useEditorStore.getState()
  return [...editor.tabs, ...Object.values(editor.projectSessions).flatMap(session => session.tabs)]
}

function reloadAfterFastForward(project: Project) {
  void useGitStatusStore
    .getState()
    .refresh(project.path, { background: true, full: true })
    .catch(() => undefined)
  window.dispatchEvent(
    new CustomEvent('qingcode:git-worktree-changed', { detail: { projectPath: project.path } }),
  )
  // 兼容模式和后台项目没有文件监听，已打开的文件要主动同步。
  const tabs = listAllTabs().filter(tab => isDescendantOf(tab.path, project.path))
  void syncOpenFilesOnFocus(tabs, { ...createDefaultSyncOpenFileDeps(), listTabs: listAllTabs }).catch(
    error => console.warn('git push sync: open-file reload failed:', error),
  )
  const store = useProjectStore.getState()
  if (store.currentProject?.id === project.id) void store.refreshProjectTree(project)
}

function notify(project: Project, result: SyncResult) {
  const { pushToast, sshConnections } = useProjectStore.getState()
  // 带上来源（如「WinDev · django」），同名项目分布在多台机器时能分清是哪一个。
  const source = projectSourceLabel(project, sshConnections, translate('本机'))
  const values = { project: `${source} · ${project.name}`, count: result.commits ?? 0 }
  switch (result.kind) {
    case 'synced':
      pushToast('success', translate('{project} 已同步 {count} 个提交', values))
      break
    case 'behind':
      pushToast('info', translate('{project} 有 {count} 个新提交可拉取', values))
      break
    case 'diverged':
      pushToast('error', translate('{project} 与远端已分叉，未自动同步', values))
      break
    case 'dirty-editors':
      pushToast('error', translate('{project} 有未保存的文件，未自动同步', values))
      break
    case 'blocked':
      pushToast('error', translate('{project} 无法快进，未自动同步', values), result.detail)
      break
  }
}

function rememberIdentity(projectId: string, keys: string[]) {
  const { config } = useGitPushSyncStore.getState()
  if (JSON.stringify(config.identities[projectId]) === JSON.stringify(keys)) return
  void saveConfig({ ...config, identities: { ...config.identities, [projectId]: keys } }).catch(
    error => console.warn('git push sync: save identity failed:', error),
  )
}

export const gitPushSyncEngine = createGitPushSyncEngine({
  projects: () => useProjectStore.getState().projects,
  config: () => useGitPushSyncStore.getState().config,
  isTrusted: isProjectTrusted,
  dirtyEditorCount: project => {
    const { tabs, projectSessions } = useEditorStore.getState()
    return countDirtyTabsByProject([project], tabs, projectSessions)[project.id] ?? 0
  },
  getStatus: getGitStatus,
  getRemotes: getGitRemotes,
  fetch: fetchForPushSync,
  mergeFastForward: fastForwardForPushSync,
  setWatches: setPushSyncWatches,
  afterFastForward: reloadAfterFastForward,
  record: (project, result) => useGitPushSyncStore.getState().setResult(project.path, result),
  notify,
  rememberIdentity,
  isLiveDetection: path => useGitPushSyncStore.getState().detection[path]?.state === 'live',
  now: () => Date.now(),
  currentProjectPath: () => useProjectStore.getState().currentProject?.path ?? null,
})
