import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { FsKind, FsReadResult, FsStat } from '@qn/protocol'
import { WorkspaceError } from '../registry'
import { readByteRange, runFs } from './io'
import {
  BINARY_SAMPLE_BYTES,
  isProtectedPath,
  looksBinary,
  mtimeConflicts,
  nodeErrorCode,
  parseDeleteParams,
  parseReadParams,
  parseRenameParams,
  parseWriteParams,
  requireAbsolutePath,
  utf8SafeLength,
} from './logic'

export async function fsStat(p: Record<string, unknown>): Promise<FsStat> {
  const filePath = requireAbsolutePath(p.path)
  return runFs(async () => {
    const stat = await fsp.lstat(filePath)
    const kind: FsKind = stat.isDirectory()
      ? 'dir'
      : stat.isSymbolicLink()
        ? 'symlink'
        : 'file'
    return { path: filePath, kind, size: stat.size, mtimeMs: stat.mtimeMs }
  })
}

export async function fsRead(p: Record<string, unknown>): Promise<FsReadResult> {
  const params = parseReadParams(p)
  return runFs(async () => {
    const { data, size, mtimeMs } = await readByteRange(params.path, params.offset, params.length)
    if (params.encoding === 'base64') {
      return {
        path: params.path,
        content: data.toString('base64'),
        encoding: 'base64',
        size,
        mtimeMs,
        offset: params.offset,
        length: data.length,
        truncated: params.offset + data.length < size,
        binary: false,
      }
    }
    if (params.encoding === undefined) {
      const sample = await readByteRange(params.path, 0, BINARY_SAMPLE_BYTES)
      if (looksBinary(sample.data)) {
        return {
          path: params.path,
          content: '',
          encoding: 'utf8',
          size,
          mtimeMs,
          offset: params.offset,
          length: 0,
          truncated: params.offset < size,
          binary: true,
        }
      }
    }
    // 字节偏移可能落在多字节字符中间，回退到完整字符边界并据实返回 length。
    const length = utf8SafeLength(data)
    return {
      path: params.path,
      content: data.subarray(0, length).toString('utf8'),
      encoding: 'utf8',
      size,
      mtimeMs,
      offset: params.offset,
      length,
      truncated: params.offset + length < size,
      binary: false,
    }
  })
}

export async function fsWrite(p: Record<string, unknown>): Promise<{ mtimeMs: number }> {
  const params = parseWriteParams(p)
  const bytes = params.encoding === 'base64'
    ? Buffer.from(params.content, 'base64')
    : Buffer.from(params.content, 'utf8')
  return runFs(async () => {
    let mode: number | undefined
    try {
      const stat = await fsp.stat(params.path)
      if (mtimeConflicts(stat.mtimeMs, params.expectedMtimeMs)) {
        throw new WorkspaceError('conflict', '文件已被外部修改')
      }
      // Windows 的 mode 只有只读位，保留权限没有意义。
      if (process.platform !== 'win32') mode = stat.mode & 0o7777
    } catch (err) {
      if (err instanceof WorkspaceError) throw err
      if (nodeErrorCode(err) !== 'ENOENT') throw err
      if (!params.create) throw new WorkspaceError('not_found', '文件不存在')
      if (params.expectedMtimeMs !== undefined) {
        throw new WorkspaceError('conflict', '文件已被删除')
      }
    }

    const tmp = path.join(
      path.dirname(params.path),
      `.qn-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
    )
    try {
      await fsp.writeFile(tmp, bytes, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) })
      if (mode !== undefined) await fsp.chmod(tmp, mode)
      try {
        await fsp.rename(tmp, params.path)
      } catch (err) {
        // Windows 上目标被占用时 rename 偶尔失败，退化成覆盖写，至少不丢已写出的内容。
        const code = nodeErrorCode(err) ?? ''
        if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(code)) throw err
        await fsp.copyFile(tmp, params.path)
      }
      const after = await fsp.stat(params.path)
      return { mtimeMs: after.mtimeMs }
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
    }
  })
}

export async function fsMkdir(p: Record<string, unknown>): Promise<Record<string, never>> {
  const dir = requireAbsolutePath(p.path)
  return runFs(async () => {
    await fsp.mkdir(dir, { recursive: true })
    return {}
  })
}

export async function fsCreateFile(p: Record<string, unknown>): Promise<Record<string, never>> {
  const filePath = requireAbsolutePath(p.path)
  return runFs(async () => {
    const handle = await fsp.open(filePath, 'wx')
    await handle.close()
    return {}
  })
}

export async function fsRename(p: Record<string, unknown>): Promise<Record<string, never>> {
  const { from, to } = parseRenameParams(p)
  return runFs(async () => {
    let exists = true
    try {
      await fsp.lstat(to)
    } catch (err) {
      if (nodeErrorCode(err) !== 'ENOENT') throw err
      exists = false
    }
    // POSIX 的 rename 会静默覆盖，先显式拒绝已存在的目标。
    if (exists) throw new WorkspaceError('exists', '目标已存在')
    await fsp.rename(from, to)
    return {}
  })
}

export async function fsDelete(p: Record<string, unknown>): Promise<Record<string, never>> {
  const { path: target, recursive } = parseDeleteParams(p)
  if (isProtectedPath(target)) {
    throw new WorkspaceError('params', '拒绝删除根目录或用户主目录')
  }
  return runFs(async () => {
    const stat = await fsp.lstat(target)
    if (stat.isDirectory()) {
      if (recursive) await fsp.rm(target, { recursive: true, force: false })
      else await fsp.rmdir(target)
    } else {
      await fsp.unlink(target)
    }
    return {}
  })
}
