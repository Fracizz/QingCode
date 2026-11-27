import { constants, promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import type { ProjectFileChunk, ProjectFileEntry, ProjectFileList } from '@qn/protocol'
import { WorkspaceError } from '../registry'
import { isSkippedDir } from './ignore'
import { runFs } from './io'
import { requireAbsolutePath } from './logic'

const MAX_DIRECTORY_ENTRIES = 2000
const MAX_SEARCH_ENTRIES = 10_000
const MAX_CHUNK = 256 * 1024

function pathParts(value: unknown): string[] {
  if (value === '' || value === undefined) return []
  if (typeof value !== 'string' || value.length > 4096) throw new WorkspaceError('params', '项目文件路径无效')
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[:\\\u0000-\u001f]/.test(part))) {
    throw new WorkspaceError('params', '请使用项目内的相对路径')
  }
  return parts
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function agentCredential(candidate: string): boolean {
  const name = path.basename(candidate).toLowerCase()
  const directory = path.basename(path.dirname(candidate)).toLowerCase()
  return name === '.credentials.json' || (directory === '.codex' && name === 'auth.json')
}

async function projectPath(root: string, parts: string[]): Promise<string> {
  let candidate = root
  for (const part of parts) {
    candidate = path.join(candidate, part)
    const stat = await fs.lstat(candidate)
    if (stat.isSymbolicLink()) throw new WorkspaceError('permission', '无法打开项目中的链接')
  }
  const actual = await fs.realpath(candidate)
  if (!inside(root, actual) || agentCredential(actual)) throw new WorkspaceError('permission', '无法访问此路径')
  return actual
}

function entryFrom(parts: string[], name: string, stat: Stats): ProjectFileEntry | null {
  if (!stat.isDirectory() && !stat.isFile()) return null
  return {
    path: [...parts, name].join('/'),
    name,
    kind: stat.isDirectory() ? 'dir' : 'file',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

async function readEntries(actual: string, parts: string[], hidden: boolean, limit: number): Promise<ProjectFileList & { visited: number }> {
  const entries: ProjectFileEntry[] = []
  let visited = 0
  let truncated = false
  const directory = await fs.opendir(actual)
  for await (const entry of directory) {
    if (++visited > limit) {
      truncated = true
      break
    }
    const { name } = entry
    if ((!hidden && name.startsWith('.')) || entry.isSymbolicLink() || (entry.isDirectory() && isSkippedDir(name))) continue
    if (/[:\\\u0000-\u001f]/.test(name)) continue
    const child = path.join(actual, name)
    if (agentCredential(child)) continue
    try {
      const result = entryFrom(parts, name, await fs.lstat(child))
      if (result) entries.push(result)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
  return { entries, truncated, visited }
}

export function listProjectFiles(params: Record<string, unknown>): Promise<ProjectFileList> {
  return runFs(async () => {
    const root = await fs.realpath(requireAbsolutePath(params.root))
    const parts = pathParts(params.path)
    const { entries, truncated } = await readEntries(await projectPath(root, parts), parts, params.hidden === true, MAX_DIRECTORY_ENTRIES)
    return { entries, truncated }
  })
}

export function searchProjectFiles(params: Record<string, unknown>): Promise<ProjectFileList> {
  return runFs(async () => {
    const root = await fs.realpath(requireAbsolutePath(params.root))
    const parts = pathParts(params.path)
    if (typeof params.query !== 'string' || params.query.length > 256) throw new WorkspaceError('params', '搜索词无效')
    const query = params.query.toLocaleLowerCase()
    const max = Number.isInteger(params.limit) ? Math.min(200, Math.max(1, Number(params.limit))) : 200
    const stack = [parts]
    const entries: ProjectFileEntry[] = []
    let budget = MAX_SEARCH_ENTRIES
    let truncated = false
    while (stack.length > 0 && budget > 0 && entries.length < max) {
      const next = stack.pop()!
      try {
        const scan = await readEntries(await projectPath(root, next), next, params.hidden === true, Math.min(budget, MAX_DIRECTORY_ENTRIES))
        // 搜索每经过一个目录也消耗预算，保证空目录树的扫描有界。
        budget -= scan.visited + 1
        truncated ||= scan.truncated
        for (const entry of scan.entries) {
          if (entry.kind === 'dir') stack.push(entry.path.split('/'))
          else if (entry.path.toLocaleLowerCase().includes(query)) {
            if (entries.length === max) { truncated = true; break }
            entries.push(entry)
          }
        }
      } catch (error) {
        if (next === parts || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { entries, truncated: truncated || stack.length > 0 }
  })
}

function versionOf(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

export function readProjectFile(params: Record<string, unknown>): Promise<ProjectFileChunk> {
  return runFs(async () => {
    const root = await fs.realpath(requireAbsolutePath(params.root))
    const parts = pathParts(params.path)
    const actual = await projectPath(root, parts)
    const offset = params.offset ?? 0
    const length = params.length ?? MAX_CHUNK
    if (!parts.length || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > MAX_CHUNK ||
      (params.version !== undefined && (typeof params.version !== 'string' || params.version.length > 160))) {
      throw new WorkspaceError('params', '下载分块参数无效')
    }

    // 预先排除设备文件和命名管道，再核对打开的文件仍在项目内。
    if (!(await fs.lstat(actual)).isFile()) throw new WorkspaceError('params', '请选择普通文件')
    const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    const handle = await fs.open(actual, flags)
    try {
      const stat = await handle.stat()
      const version = versionOf(stat)
      if (!stat.isFile() || versionOf(await fs.stat(await projectPath(root, parts))) !== version ||
        (params.version !== undefined && params.version !== version) || offset > stat.size) {
        throw new WorkspaceError('conflict', '文件已变化，请重新下载')
      }
      const buffer = Buffer.allocUnsafe(Math.min(length, stat.size - offset))
      let read = 0
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      if (read !== buffer.length || versionOf(await handle.stat()) !== version ||
        versionOf(await fs.stat(await projectPath(root, parts))) !== version) {
        throw new WorkspaceError('conflict', '文件已变化，请重新下载')
      }
      return { content: buffer.toString('base64'), length: read, size: stat.size, version }
    } finally {
      await handle.close()
    }
  })
}
