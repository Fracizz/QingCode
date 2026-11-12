import type { Project } from '../types'
import { isTauri, safeInvoke } from './tauri'
import { isProjectTrusted } from './workspaceTrust'
import { isSshProject, isSshWorkspaceReady } from './sshWorkspace'
import { loadScopedTerminalPasteRetentionDays } from './terminal/terminalPasteCleanupSettings'
import { isTransferActive, useTransferStore } from '../store/transferStore'
import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import { translate } from './i18n'

const pending = new Set<string>()

export async function cleanupTerminalPaste(project: Project, retentionDays: number): Promise<number> {
  if (!isProjectTrusted(project)) return 0
  if (isSshProject(project) && !await isSshWorkspaceReady(project.path)) return 0
  const excludedPaths = useTransferStore.getState().tasks
    .filter(task => task.request.direction === 'upload' && isTransferActive(task.status))
    .map(task => task.request.destination)
  return safeInvoke<number>('清理粘贴文件', 'cleanup_terminal_paste', {
    path: project.path, retentionDays, excludedPaths,
  })
}

/** Called only after project activation. No awaited work or recurring timer in the open path. */
export function scheduleTerminalPasteCleanup(project: Project): void {
  if (!isTauri() || project.ephemeral || pending.has(project.path)) return
  pending.add(project.path)
  setTimeout(() => {
    void (async () => {
      if (!isProjectTrusted(project)) return
      if (isSshProject(project) && !await isSshWorkspaceReady(project.path)) return
      const days = await loadScopedTerminalPasteRetentionDays('project', project)
      if (days > 0) await cleanupTerminalPaste(project, days)
    })().catch(error => console.warn('Terminal paste cleanup skipped:', error))
      .finally(() => pending.delete(project.path))
  }, 3000)
}

export async function confirmClearTerminalPaste(project: Project): Promise<void> {
  const ok = await confirmDialog({
    title: translate('清理粘贴文件'),
    message: translate('删除当前项目下的粘贴附件？'),
    detail: translate('历史终端和会话中的附件路径会失效。正在上传的批次会跳过。'),
    kind: 'warning', confirmLabel: translate('清理'),
  })
  if (!ok) return
  const store = useProjectStore.getState()
  try {
    const count = await cleanupTerminalPaste(project, 0)
    store.pushToast('info', translate(count ? '已清理粘贴文件' : '没有需要清理的粘贴文件'))
    if (count) void store.refreshProjectTree(project)
  } catch (error) {
    store.pushToast('error', translate('清理粘贴文件失败：{error}', { error: String(error) }))
  }
}
