import { invoke as rawInvoke, isTauri as coreIsTauri } from '@tauri-apps/api/core'
import { recordTauriCommandDuration } from './performanceDiagnostics'

const SSH_COMMANDS: Partial<Record<string, string>> = {
  validate_directory: 'ssh_validate_directory',
  scan_directory: 'ssh_scan_directory',
  file_stat: 'ssh_file_stat',
  file_mtime: 'ssh_file_mtime',
  read_file: 'ssh_read_file',
  detect_file_encoding: 'ssh_detect_file_encoding',
  read_file_slice: 'ssh_read_file_slice',
  write_file: 'ssh_write_file',
  create_file: 'ssh_create_file',
  create_directory: 'ssh_create_directory',
  rename_path: 'ssh_rename_path',
  delete_path: 'ssh_delete_path',
  check_symlink_write: 'ssh_check_symlink_write',
  list_file_extensions: 'ssh_list_file_extensions',
  search_files: 'ssh_search_files',
  search_file_contents: 'ssh_search_file_contents',
  git_status: 'ssh_git_status',
  git_stage: 'ssh_git_stage',
  git_unstage: 'ssh_git_unstage',
  git_commit: 'ssh_git_commit',
  git_push: 'ssh_git_push',
  git_fetch: 'ssh_git_fetch',
  git_pull: 'ssh_git_pull',
}

export function isSshResource(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('ssh://')
}

function remoteCommand(cmd: string, args?: Record<string, unknown>): string {
  const mapped = SSH_COMMANDS[cmd]
  if (!mapped || !args) return cmd
  const hasRemoteResource = Object.values(args).some(
    value =>
      isSshResource(value) || (Array.isArray(value) && value.some(item => isSshResource(item)))
  )
  return hasRemoteResource ? mapped : cmd
}

/** Whether the app is running inside the Tauri desktop runtime. */
export function isTauri(): boolean {
  return coreIsTauri()
}

export class NotInTauriError extends Error {
  constructor(action: string) {
    super(
      `「${action}」需要 Tauri 桌面环境，当前在浏览器中预览不可用。请使用 \`pnpm tauri dev\` 启动后再试。`
    )
    this.name = 'NotInTauriError'
  }
}

/**
 * invoke() wrapper that fails with a friendly, actionable error when the
 * app is not running inside Tauri, instead of crashing on undefined access.
 */
export async function safeInvoke<T = unknown>(
  action: string,
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isTauri()) throw new NotInTauriError(action)
  const started = performance.now()
  let succeeded = false
  const resolvedCommand = remoteCommand(cmd, args)
  try {
    const result = await rawInvoke<T>(resolvedCommand, args)
    succeeded = true
    return result
  } finally {
    recordTauriCommandDuration(resolvedCommand, performance.now() - started, succeeded)
  }
}

/** Throws a friendly error if called outside the Tauri runtime. */
export async function requireTauri(action: string): Promise<void> {
  if (!isTauri()) throw new NotInTauriError(action)
}

/** Native fallback for WebView2 mouse events that omit the physical Ctrl state. */
export async function isPrimaryModifierPressed(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await rawInvoke<boolean>('primary_modifier_pressed')
  } catch {
    return false
  }
}
