import { open } from '@tauri-apps/plugin-dialog'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import { useEditorStore } from '../store/editorStore'
import { confirmDialog } from '../store/confirmStore'
import { promptDialog, validateEntryName } from '../store/promptStore'
import { isTauri } from '../lib/tauri'
import { translate } from '../lib/i18n'

/** Confirm then remove a project, tearing down its terminals and editor tabs. */
export async function removeProjectWithConfirm(id: string, name: string, path: string) {
  const terminals = useTerminalStore.getState().terminals
  const runningCount = terminals.filter(t => t.projectId === id && t.status !== 'exited').length
  if (isTauri()) {
    const ok = await confirmDialog({
      title: translate('移除项目'),
      message: translate('确定从工作区移除「{name}」？', { name }),
      detail:
        runningCount > 0
          ? translate('该项目有 {count} 个运行中的终端，移除后将被终止。\n不会删除磁盘上的项目文件。', { count: runningCount })
          : translate('不会删除磁盘上的项目文件。'),
      kind: 'warning',
      confirmLabel: translate('移除'),
      cancelLabel: translate('取消'),
    })
    if (!ok) return
  }
  try {
    await useTerminalStore.getState().closeProjectTerminals(id)
    useEditorStore.getState().closeTabsForPath(path)
    await useProjectStore.getState().removeProject(id)
  } catch (e) {
    useProjectStore.getState().pushToast('error', translate('移除项目失败: {error}', { error: String(e) }))
  }
}

/** Open a directory picker and relocate the project, updating terminal cwds on success. */
export async function relocateProjectWithDialog(id: string) {
  try {
    const selected = await open({ directory: true, multiple: false })
    if (typeof selected === 'string' && (await useProjectStore.getState().relocateProject(id, selected))) {
      useTerminalStore.getState().updateProjectPath(id, selected)
    }
  } catch (e) {
    useProjectStore.getState().pushToast('error', translate('重新定位项目失败: {error}', { error: String(e) }))
  }
}

/** Prompt for a name and create a lightweight terminal-only project (scratch dir under temp). */
export async function addTerminalProjectWithPrompt() {
  const name = await promptDialog({
    title: translate('新建终端项目'),
    message: translate('项目名称'),
    defaultValue: translate('终端项目'),
    confirmLabel: translate('新建'),
    validate: validateEntryName,
  })
  if (!name) return
  await useProjectStore.getState().addTerminalProject(name.trim())
}

/** Prompt for a new display name and rename the project. */
export async function renameProjectWithPrompt(id: string, currentName: string) {
  const name = await promptDialog({
    title: translate('重命名项目'),
    message: translate('项目名称'),
    defaultValue: currentName,
    confirmLabel: translate('重命名'),
    validate: validateEntryName,
  })
  if (!name || name === currentName) return
  await useProjectStore.getState().renameProject(id, name.trim())
}
