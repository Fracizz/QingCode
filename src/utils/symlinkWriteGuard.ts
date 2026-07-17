import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import { authorizePaths } from '../lib/pathAllowlist'
import { safeInvoke } from '../lib/tauri'
import { translate } from '../lib/i18n'

export type SymlinkWriteCheck = {
  needsConfirm: boolean
  resolvedPath: string | null
}

/**
 * Prompt when a write would follow a symlink to a target outside project roots.
 * Fail closed: inspect / authorize errors cancel the write. Native `write_file`
 * still re-checks the path sandbox (canonicalize + allowlist) and is the real gate.
 */
export async function confirmOutsideSymlinkWrite(path: string): Promise<boolean> {
  let check: SymlinkWriteCheck
  try {
    check = await safeInvoke<SymlinkWriteCheck>('检查符号链接写入', 'check_symlink_write', {
      path,
    })
  } catch (error) {
    useProjectStore.getState().pushToast(
      'error',
      translate('无法验证符号链接写入目标，已取消保存'),
      String(error),
    )
    return false
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
  if (result !== true) return false

  const grants = [path]
  if (check.resolvedPath) grants.push(check.resolvedPath)
  try {
    await authorizePaths(grants)
  } catch (error) {
    useProjectStore.getState().pushToast(
      'error',
      translate('授权符号链接目标失败，已取消保存'),
      String(error),
    )
    return false
  }
  return true
}
