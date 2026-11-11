/** 把引擎接到应用的 store、IPC 和持久化上。 */
import { getGitRemotes } from '@/lib/ipc/git'
import {
  fastForwardForPushSync,
  fetchForPushSync,
  getPushSyncTracking,
  setPushSyncWatches,
} from '@/lib/ipc/gitPushSync'
import { gitPullErrorI18n } from '@/lib/git/gitErrorMessage'
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

/** git 原始 stderr 是英文，转成已本地化的简明说明再展示。 */
function localizeBlockedDetail(raw: string): string {
  const i18n = gitPullErrorI18n(raw)
  return translate(i18n.key, i18n.params)
}

function notify(project: Project, result: SyncResult) {
  const { pushToast, sshConnections } = useProjectStore.getState()
  // 项目名后带来源徽标（如「django [WSL]」），同名项目分布在多台机器时能分清是哪一个。
  // `{project}` 原样保留，由 Toaster 渲染为与项目卡片标题一致的名称 + 徽标。
  const subject = { name: project.name, source: projectSourceLabel(project, sshConnections, translate('本机')) }
  const values = { count: result.commits ?? 0 }
  const toast = (kind: 'success' | 'info' | 'error', key: string, detail?: string) =>
    pushToast(kind, translate(key, values), detail, undefined, subject)
  switch (result.kind) {
    case 'synced':
      toast('success', '{project} 已同步 {count} 个提交')
      break
    case 'behind':
      toast('info', '{project} 有 {count} 个新提交可拉取')
      break
    case 'diverged':
      toast('error', '{project} 与远端已分叉，未自动同步')
      break
    case 'dirty-editors':
      toast('error', '{project} 有未保存的文件，未自动同步')
      break
    case 'blocked':
      toast(
        'error',
        '{project} 无法快进，未自动同步',
        result.detail ? localizeBlockedDetail(result.detail) : undefined,
      )
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
  getTracking: getPushSyncTracking,
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
