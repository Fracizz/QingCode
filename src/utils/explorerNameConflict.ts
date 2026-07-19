import { explorerConflictDialog } from '../store/explorerConflictStore'
import { safeInvoke } from '../lib/tauri'
import { baseName } from './fileTreeHelpers'
import { translate } from '../lib/i18n'

export type ExplorerConflictDecision =
  | { action: 'overwrite' }
  | { action: 'skip' }
  | { action: 'rename'; newName: string }
  | { action: 'cancel' }

type ApplyAll = 'overwrite' | 'skip'

function joinChildPath(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`
}

/** Suggest `name - Copy.ext` like the native unique-name helper. */
export function suggestCopyName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    const stem = name.slice(0, dot)
    const ext = name.slice(dot)
    if (!stem.endsWith(' - Copy') && !/ - Copy \(\d+\)$/.test(stem)) {
      return `${stem} - Copy${ext}`
    }
  } else if (!name.endsWith(' - Copy') && !/ - Copy \(\d+\)$/.test(name)) {
    return `${name} - Copy`
  }
  return `${name} - Copy`
}

/** Returns destination path when `destDir/name` already exists; otherwise null. */
export async function findExplorerNameConflict(
  sourcePath: string,
  destDir: string,
): Promise<{ destPath: string; name: string; isDir: boolean } | null> {
  const name = baseName(sourcePath)
  const destPath = joinChildPath(destDir, name)
  try {
    const stat = await safeInvoke<{ size: number; is_dir: boolean }>('读取文件信息', 'file_stat', {
      path: destPath,
    })
    return { destPath, name, isDir: Boolean(stat.is_dir) }
  } catch {
    return null
  }
}

/**
 * IDEA-style conflict: inline rename field + Overwrite / Skip (+ apply-to-all when batching).
 */
export async function resolveExplorerNameConflict(options: {
  conflict: { destPath: string; name: string; isDir: boolean }
  operation: 'copy' | 'move'
  remainingCount: number
  applyAll: { current: ApplyAll | null }
}): Promise<ExplorerConflictDecision> {
  if (options.applyAll.current === 'overwrite') return { action: 'overwrite' }
  if (options.applyAll.current === 'skip') return { action: 'skip' }

  const kind = options.conflict.isDir ? translate('文件夹') : translate('文件')
  const opLabel = options.operation === 'copy' ? translate('复制') : translate('移动')
  const multi = options.remainingCount > 1

  const result = await explorerConflictDialog({
    title: translate('目标已存在'),
    message: translate('「{name}」已存在。可直接改名后重命名，或覆盖 / 跳过。', {
      name: options.conflict.name,
    }),
    detail: [
      translate('{kind}：{name}', { kind, name: options.conflict.name }),
      translate('目标：{path}', { path: options.conflict.destPath }),
      translate('操作：{op}', { op: opLabel }),
    ].join('\n'),
    defaultName: suggestCopyName(options.conflict.name),
    originalName: options.conflict.name,
    showApplyAll: multi,
  })

  if (result.action === 'overwrite_all') {
    options.applyAll.current = 'overwrite'
    return { action: 'overwrite' }
  }
  if (result.action === 'skip_all') {
    options.applyAll.current = 'skip'
    return { action: 'skip' }
  }
  if (result.action === 'overwrite') return { action: 'overwrite' }
  if (result.action === 'skip') return { action: 'skip' }
  if (result.action === 'rename') return { action: 'rename', newName: result.newName }
  return { action: 'cancel' }
}
