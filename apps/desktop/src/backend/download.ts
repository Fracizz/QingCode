import { mkdtemp, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectFileChunk } from '@qn/protocol'

const chunkSize = 256 * 1024

/** 临时文件与目标同卷，只有所有分块属于同一版本才替换用户所选文件。 */
export async function downloadFile(destination: string, read: (
  offset: number, length: number, version?: string
) => Promise<ProjectFileChunk>): Promise<void> {
  const dir = await mkdtemp(join(dirname(destination), '.qn-download-'))
  const temporary = join(dir, 'content')
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      let offset = 0
      let version: string | undefined
      let size: number | undefined
      do {
        const chunk = await read(offset, chunkSize, version)
        if (typeof chunk?.version !== 'string' || !chunk.version ||
          (version !== undefined && chunk.version !== version) || (size !== undefined && chunk.size !== size)) {
          throw new Error('远程文件已变化，请重新下载')
        }
        size = chunk.size
        version = chunk.version
        if (!Number.isSafeInteger(size) || size < 0 || typeof chunk.content !== 'string' ||
          chunk.length !== Math.min(chunkSize, size - offset) || chunk.content.length !== 4 * Math.ceil(chunk.length / 3)) {
          throw new Error('下载数据不完整')
        }
        const bytes = Buffer.from(chunk.content, 'base64')
        if (bytes.length !== chunk.length) throw new Error('下载数据不完整')
        await handle.writeFile(bytes)
        offset += bytes.length
      } while (offset < size)
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
