import { isSshResource } from './tauri'

export type ExplorerClipboard = { mode: 'cut' | 'copy'; paths: string[] }

export type ExplorerPastePlan =
  | { kind: 'upload'; paths: string[]; fromSystem: boolean }
  | { kind: 'internal'; clipboard: ExplorerClipboard }
  | { kind: 'none' }

/** 系统剪贴板文件列表的签名，用于判断应用内复制之后用户是否又在系统里复制了文件。 */
export function systemClipboardSignature(paths: string[]): string {
  return paths.map(path => path.trim()).filter(Boolean).join('\n')
}

/**
 * 决定资源管理器粘贴走哪条路径：
 * - SSH 目标：系统剪贴板里有本机文件，且比应用内复制更新时，上传这些文件/文件夹；
 *   应用内复制的是本机路径时同样上传；
 * - 其它情况沿用应用内复制/剪切。
 */
export function planExplorerPaste(options: {
  destDir: string
  clipboard: ExplorerClipboard | null
  systemFiles: string[]
  /** 应用内复制/剪切当时系统剪贴板的签名；未知时为 null。 */
  systemSignatureAtInternalCopy: string | null
}): ExplorerPastePlan {
  const { destDir, clipboard, systemFiles, systemSignatureAtInternalCopy } = options
  const remoteDest = isSshResource(destDir)
  const localSystemFiles = systemFiles.filter(path => path.trim() && !isSshResource(path))
  if (remoteDest && localSystemFiles.length > 0) {
    const newerThanInternal =
      !clipboard || systemClipboardSignature(localSystemFiles) !== systemSignatureAtInternalCopy
    if (newerThanInternal) return { kind: 'upload', paths: localSystemFiles, fromSystem: true }
  }
  if (!clipboard || clipboard.paths.length === 0) return { kind: 'none' }
  if (remoteDest && clipboard.paths.every(path => !isSshResource(path))) {
    return { kind: 'upload', paths: clipboard.paths, fromSystem: false }
  }
  return { kind: 'internal', clipboard }
}
