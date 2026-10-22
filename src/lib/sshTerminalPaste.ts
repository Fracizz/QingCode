import { authorizePaths } from './pathAllowlist'
import { isSshResource, isTauri, safeInvoke } from './tauri'
import { startSshTransfer } from './sshTransfer'
import { joinSshResource, sshRemotePathFromUri } from './sshWorkspace'
import { windowsSshShellLabel } from '../utils/terminalName'
import { baseName } from '../utils/fileTreeHelpers'
import { findProjectForPath } from '../utils/fileReferences'
import { translate } from './i18n'
import { confirmDialog } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'

export const TERMINAL_DROP_ATTR = 'data-terminal-id'
export const TERMINAL_PASTE_DIR = 'terminal-paste'
/** Reject terminal paste uploads above this size. Equal to 100MB is still allowed. */
export const SSH_TERMINAL_PASTE_MAX_BYTES = 100 * 1024 * 1024

const WINDOWS_ABS = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+\\)/
const FILE_URL = /^file:\/\//i

function isWindowsHost(): boolean {
  return /Windows/i.test(navigator.userAgent)
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function fileUrlToPath(source: string): string | null {
  try {
    const url = new URL(source)
    if (url.protocol !== 'file:') return null
    const decoded = decodeURIComponent(url.pathname)
    if (url.host) return `//${url.host}${decoded}`.replace(/\//g, '\\')
    const drive = decoded.replace(/^\/([a-zA-Z]:)/, '$1')
    return drive.replace(/\//g, WINDOWS_ABS.test(drive) ? '\\' : '/')
  } catch {
    return null
  }
}

export function isLocalAbsolutePath(path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || trimmed.startsWith('ssh://')) return false
  if (WINDOWS_ABS.test(trimmed)) return true
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return !isWindowsHost()
  return false
}

/**
 * True when the clipboard text is *only* local absolute file paths
 * (Explorer / Windows Terminal style), so an SSH paste can upload them.
 */
export function parseLocalFilePasteText(text: string): string[] | null {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => stripWrappingQuotes(line.trim()))
    .map(line => (FILE_URL.test(line) ? fileUrlToPath(line) ?? line : line))
    .filter(Boolean)
  if (lines.length === 0) return null
  if (!lines.every(isLocalAbsolutePath)) return null
  return lines
}

export function quotePosixShellPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

export function quotePowerShellPath(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/** Convert an `ssh://` file into the path the remote shell actually understands. */
export function remoteShellPathFromUri(cwd: string, uri: string): string {
  const posix = sshRemotePathFromUri(uri)
  if (!windowsSshShellLabel(cwd)) return posix
  const match = posix.match(/^\/([A-Za-z]:)(\/.*)?$/)
  if (!match) return posix
  return `${match[1]}${(match[2] ?? '').replace(/\//g, '\\')}`
}

export function formatRemotePasteText(cwd: string, uris: string[]): string {
  const quote = windowsSshShellLabel(cwd) ? quotePowerShellPath : quotePosixShellPath
  return uris.map(uri => quote(remoteShellPathFromUri(cwd, uri))).join(' ')
}

async function ensureSshDirectory(parent: string, name: string): Promise<string> {
  const path = joinSshResource(parent, name)
  try {
    await safeInvoke('检查远程目录', 'validate_directory', { path })
    return path
  } catch {
    try {
      return await safeInvoke<string>('创建远程目录', 'create_directory', { parent, name })
    } catch (error) {
      try {
        await safeInvoke('检查远程目录', 'validate_directory', { path })
        return path
      } catch {
        throw error
      }
    }
  }
}

async function existingLocalPaths(paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  await authorizePaths(paths)
  const kept: string[] = []
  for (const path of paths) {
    try {
      await safeInvoke('读取文件信息', 'file_stat', { path })
      kept.push(path)
    } catch {
      return []
    }
  }
  return kept
}

export async function readClipboardFileList(): Promise<string[]> {
  if (!isTauri()) return []
  try {
    const paths = await safeInvoke<string[]>('读取剪贴板文件', 'clipboard_read_files')
    return Array.isArray(paths) ? paths.filter(path => path.trim()) : []
  } catch {
    return []
  }
}

export async function collectLocalFilesForSshPaste(
  event?: ClipboardEvent | null,
): Promise<string[]> {
  const fromClipboard = await readClipboardFileList()
  if (fromClipboard.length > 0) {
    await authorizePaths(fromClipboard)
    return fromClipboard
  }
  const text =
    event?.clipboardData?.getData('text/plain') ||
    (await navigator.clipboard.readText().catch(() => ''))
  const parsed = text ? parseLocalFilePasteText(text) : null
  if (!parsed) return []
  return existingLocalPaths(parsed)
}

export function sshTerminalPasteRoot(projectPath: string): string {
  return joinSshResource(projectPath, '.qingcode', TERMINAL_PASTE_DIR)
}

function resolveSshProjectRoot(cwd: string): string {
  const project = findProjectForPath(useProjectStore.getState().projects, cwd)
  return project?.path || cwd
}

async function assertLocalPasteWithinSizeLimit(paths: string[]): Promise<void> {
  await authorizePaths(paths)
  const tooLarge: string[] = []
  for (const path of paths) {
    const stat = await safeInvoke<{ size: number; is_dir: boolean }>(
      '读取文件信息',
      'file_stat',
      { path },
    )
    const size = stat.is_dir
      ? (
          await safeInvoke<{ totalSize: number }>(
            '读取文件夹条目数',
            'directory_entry_counts',
            { path },
          )
        ).totalSize
      : stat.size
    if (size > SSH_TERMINAL_PASTE_MAX_BYTES) tooLarge.push(baseName(path) || path)
  }
  if (tooLarge.length === 0) return
  throw new Error(
    translate('终端粘贴上传不接受超过 100MB 的文件或文件夹：{name}', {
      name: tooLarge.join('、'),
    }),
  )
}

export async function uploadLocalFilesForSshTerminal(
  cwd: string,
  localPaths: string[],
): Promise<string | null> {
  if (!isSshResource(cwd) || localPaths.length === 0) return null
  await assertLocalPasteWithinSizeLimit(localPaths)
  useProjectStore.getState().pushToast('info', translate('正在上传本机文件到远程终端…'))
  const root = resolveSshProjectRoot(cwd)
  const qingcode = await ensureSshDirectory(root, '.qingcode')
  const pasteRoot = await ensureSshDirectory(qingcode, TERMINAL_PASTE_DIR)
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const destination = await ensureSshDirectory(pasteRoot, stamp)
  const result = await startSshTransfer({
    direction: 'upload',
    destination,
    paths: localPaths,
    ephemeral: true,
  })
  if (result.status !== 'completed') {
    throw new Error(result.error?.trim() || translate('上传未完成'))
  }
  const uris = localPaths.map(path => joinSshResource(destination, baseName(path)))
  return formatRemotePasteText(cwd, uris)
}

export async function pasteLocalFilesIntoSshTerminal(
  cwd: string,
  localPaths: string[],
): Promise<string | null> {
  const store = useProjectStore.getState()
  try {
    const text = await uploadLocalFilesForSshTerminal(cwd, localPaths)
    if (text) store.pushToast('success', translate('已上传并粘贴远程路径'))
    return text
  } catch (error) {
    store.pushToast('error', translate('上传到远程终端失败：{error}', { error: String(error) }))
    return null
  }
}

export async function clearSshTerminalPasteUploads(
  projectPath: string,
): Promise<'cleared' | 'missing'> {
  const pasteRoot = sshTerminalPasteRoot(resolveSshProjectRoot(projectPath))
  try {
    await safeInvoke('检查远程目录', 'validate_directory', { path: pasteRoot })
  } catch {
    return 'missing'
  }
  await safeInvoke('删除', 'delete_path', { path: pasteRoot })
  const store = useProjectStore.getState()
  const project = findProjectForPath(store.projects, projectPath)
  if (project) void store.refreshProjectTree(project)
  return 'cleared'
}

export async function confirmClearSshTerminalPasteUploads(projectPath: string): Promise<void> {
  const store = useProjectStore.getState()
  const ok = await confirmDialog({
    title: translate('清理远程粘贴文件'),
    message: translate('删除该 SSH 项目下的 .qingcode/terminal-paste 目录？'),
    detail: translate('终端里已经粘贴的路径会失效。不会删除其它远程文件。'),
    kind: 'warning',
    confirmLabel: translate('清理'),
  })
  if (!ok) return
  try {
    const result = await clearSshTerminalPasteUploads(projectPath)
    if (result === 'missing') {
      store.pushToast('info', translate('没有需要清理的粘贴文件'))
      return
    }
    store.pushToast('success', translate('已清理远程粘贴目录'))
  } catch (error) {
    store.pushToast('error', translate('清理远程粘贴目录失败：{error}', { error: String(error) }))
  }
}
