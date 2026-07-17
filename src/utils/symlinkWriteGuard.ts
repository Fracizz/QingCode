import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import { safeInvoke } from '../lib/tauri'
import { translate } from '../lib/i18n'

export type SymlinkWriteCheck = {
  needsConfirm: boolean
  resolvedPath: string | null
}

/** Prompt when a write would follow a symlink to a target outside all project roots. */
export async function confirmOutsideSymlinkWrite(path: string): Promise<boolean> {
  const projectRoots = useProjectStore.getState().projects.map(project => project.path)
  let check: SymlinkWriteCheck
  try {
    check = await safeInvoke<SymlinkWriteCheck>('检查符号链接写入', 'check_symlink_write', {
      path,
      projectRoots,
    })
  } catch {
    // Fail open on inspect errors so ordinary saves are not blocked.
    return true
  }
  if (!check.needsConfirm) return true

  const result = await confirmDialog({
    title: translate('符号链接写入警告'),
    message: translate('即将写入项目外的符号链接目标，确定继续？'),
    detail: translate('解析后的目标路径：\n{path}', {
      path: check.resolvedPath ?? path,
    }),
    kind: 'warning',
    confirmLabel: translate('继续写入'),
    cancelLabel: translate('取消'),
  })
  return result === true
}
