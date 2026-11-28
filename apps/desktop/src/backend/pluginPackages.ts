import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { MAX_RG_BINARY_BYTES, parseRgPluginInfo, RG_PLUGIN_PLATFORMS, type RgPluginInfo, type RgPluginPlatform } from '@qn/protocol'
import { RouterError } from './router'

const unzip = promisify(gunzip)
const MAX_ARCHIVE_BYTES = 9 * 1024 * 1024
const MAX_BASE64 = Math.ceil(MAX_RG_BINARY_BYTES / 3) * 4

async function readArchive(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ARCHIVE_BYTES) {
      throw new RouterError('invalid_params', '插件包大小无效')
    }
    const chunks: Buffer[] = []
    for await (const chunk of handle.createReadStream({ end: MAX_ARCHIVE_BYTES, autoClose: false })) {
      chunks.push(chunk as Buffer)
    }
    const archive = Buffer.concat(chunks)
    if (archive.length > MAX_ARCHIVE_BYTES) throw new RouterError('invalid_params', '插件包大小无效')
    return archive
  } finally {
    await handle.close()
  }
}

export async function unpackRgPlugin(archive: Buffer): Promise<{ info: RgPluginInfo; binary: string }> {
  let raw: unknown
  try {
    const bytes = await unzip(archive, { maxOutputLength: MAX_BASE64 + 512 * 1024 })
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new RouterError('invalid_params', '插件包格式无效')
  }
  if (!raw || typeof raw !== 'object') throw new RouterError('invalid_params', '插件包格式无效')
  const { format, tool, info: metadata, binary, license } = raw as Record<string, unknown>
  const info = parseRgPluginInfo(metadata)
  if (format !== 1 || tool !== 'rg' || !info || typeof license !== 'string' || !license.trim() ||
      typeof binary !== 'string' || binary.length === 0 || binary.length > MAX_BASE64) {
    throw new RouterError('invalid_params', '插件包格式无效')
  }
  const bytes = Buffer.from(binary, 'base64')
  if (!bytes.length || bytes.length > MAX_RG_BINARY_BYTES || bytes.toString('base64') !== binary ||
      createHash('sha256').update(bytes).digest('hex') !== info.sha256) {
    throw new RouterError('invalid_params', '插件 SHA-256 校验失败')
  }
  return { info, binary }
}

export class PluginPackages {
  readonly #directory: string

  constructor(userData: string) {
    this.#directory = join(userData, 'plugins', 'rg')
  }

  #path(platform: RgPluginPlatform): string {
    return join(this.#directory, `${platform}.qnplugin`)
  }

  async list(): Promise<RgPluginInfo[]> {
    const entries: RgPluginInfo[] = []
    // 逐个校验，避免启动管理页时同时解压多个平台的大包。
    for (const platform of RG_PLUGIN_PLATFORMS) {
      const entry = await this.read(platform).catch(() => null)
      if (entry) entries.push(entry.info)
    }
    return entries
  }

  async read(platform: RgPluginPlatform): Promise<{ info: RgPluginInfo; binary: string }> {
    try {
      return await unpackRgPlugin(await readArchive(this.#path(platform)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RouterError('not_found', '请先导入目标平台的插件包')
      throw error
    }
  }

  async import(path: string): Promise<RgPluginInfo> {
    const archive = await readArchive(path)
    const { info } = await unpackRgPlugin(archive)
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const destination = this.#path(info.platform)
    const tmp = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, archive, { flag: 'wx', mode: 0o600 })
      await rename(tmp, destination)
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
    return info
  }

  async remove(platform: RgPluginPlatform): Promise<void> {
    await rm(this.#path(platform), { force: true })
  }
}
