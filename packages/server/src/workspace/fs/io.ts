import { promises as fsp } from 'node:fs'
import { mapNodeError } from './logic'

export interface ByteRange {
  data: Buffer
  size: number
  mtimeMs: number
}

/** 只读取需要的字节区间，避免大文件整体进内存（单帧上限 16 MiB）。 */
export async function readByteRange(filePath: string, offset: number, maxBytes: number): Promise<ByteRange> {
  const handle = await fsp.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const want = Math.max(0, Math.min(maxBytes, stat.size - offset))
    const buffer = Buffer.allocUnsafe(want)
    let read = 0
    while (read < want) {
      const result = await handle.read(buffer, read, want - read, offset + read)
      if (result.bytesRead <= 0) break
      read += result.bytesRead
    }
    return { data: buffer.subarray(0, read), size: stat.size, mtimeMs: stat.mtimeMs }
  } finally {
    await handle.close()
  }
}

/** 所有 fs IO 异常统一映射成协议错误码，WorkspaceError 原样透传。 */
export async function runFs<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw mapNodeError(err)
  }
}
