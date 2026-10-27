import type { TerminalTab } from '@/types'
import { isSshResource, isTauri, safeInvoke } from '../tauri'
import { authorizePaths } from '../pathAllowlist'
import {
  collectLocalFilesForSshPaste,
  readClipboardFileList,
  pasteLocalFilesIntoSshTerminal,
  quotePosixShellPath,
  quotePowerShellPath,
  SSH_TERMINAL_PASTE_MAX_BYTES,
} from '../sshTerminalPaste'
import { translate } from '../i18n'

export type AttachmentTarget = Pick<
  TerminalTab,
  'cwd' | 'shell' | 'resolvedShell' | 'runEnvironment'
>

export function isSameTerminalSession(
  before: TerminalTab,
  after: TerminalTab | undefined
): boolean {
  return (
    !!after &&
    after.status === 'running' &&
    !after.ptySpawnPending &&
    before.id === after.id &&
    before.cwd === after.cwd &&
    before.startedAt === after.startedAt &&
    before.ptyId === after.ptyId
  )
}

export function formatLocalAttachmentPaths(target: AttachmentTarget, paths: string[]): string {
  const shell = target.resolvedShell ?? target.shell
  // WSL/Linux use POSIX quoting; no Windows-path rewriting based on the frontend OS.
  const windows =
    target.runEnvironment?.os === 'windows' ||
    (!target.runEnvironment &&
      shell !== 'wsl' &&
      shell !== 'bash' &&
      shell !== 'zsh' &&
      /Windows/i.test(navigator.userAgent))
  if (!windows) return paths.map(quotePosixShellPath).join(' ')
  if (shell === 'cmd') return paths.map(path => `"${path.replace(/"/g, '""')}"`).join(' ')
  return paths.map(quotePowerShellPath).join(' ')
}

/** Materialize browser clipboard blobs only; native copied files keep their paths. */
export async function storeAttachmentFiles(files: File[]): Promise<string[]> {
  const paths: string[] = []
  for (const file of files) {
    if (file.size > SSH_TERMINAL_PASTE_MAX_BYTES) throw new Error(translate('附件不能超过 100MB'))
    const name = file.name || (file.type === 'image/png' ? 'screenshot.png' : 'attachment')
    paths.push(
      await safeInvoke<string>('保存终端附件', 'clipboard_store_file', {
        name,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      })
    )
  }
  return paths
}

export async function prepareTerminalAttachments(
  target: AttachmentTarget,
  paths: string[]
): Promise<string | null> {
  if (!paths.length) return null
  await authorizePaths(paths)
  if (isSshResource(target.cwd)) return pasteLocalFilesIntoSshTerminal(target.cwd, paths)
  return formatLocalAttachmentPaths(target, paths)
}

export async function terminalClipboardPaths(event?: ClipboardEvent): Promise<string[]> {
  // Copy browser File objects before awaiting: the clipboard event is short lived.
  const files = Array.from(event?.clipboardData?.files ?? [])
  if (files.length) {
    // Native screenshots already have a file representation; avoid JSON-encoding their bytes.
    if (isTauri()) {
      const paths = await readClipboardFileList()
      if (paths.length) return paths
    }
    return storeAttachmentFiles(files)
  }
  return collectLocalFilesForSshPaste(event)
}
