import { readdir } from 'node:fs/promises'
import os from 'node:os'
import type { FsEntry } from '@qn/protocol'
import { nativeAgentCwd } from './workspace/paths'

const MAX_ENTRIES = 2000

export function fsHome(): { path: string } {
  return { path: os.homedir() }
}

export interface FsListOptions {
  path: string
  dirsOnly?: boolean
}

/** dirsOnly 保留符号链接：浏览目录时无法不 stat 就判断它是否指向目录。 */
export async function fsList(options: FsListOptions): Promise<{ path: string; entries: FsEntry[] }> {
  // 旧版 SSH 项目可能传 `/D:/x`；读取用本机路径，回包仍回显请求路径，便于调用方按原值匹配。
  const dirents = await readdir(nativeAgentCwd(options.path), { withFileTypes: true })
  const entries: FsEntry[] = []
  for (const dirent of dirents) {
    const kind: FsEntry['kind'] = dirent.isDirectory()
      ? 'dir'
      : dirent.isSymbolicLink()
        ? 'symlink'
        : 'file'
    if (options.dirsOnly && kind === 'file') continue
    entries.push({ name: dirent.name, kind })
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { path: options.path, entries: entries.slice(0, MAX_ENTRIES) }
}
