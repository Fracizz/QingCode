import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { isRgPluginPlatform, MAX_RG_BINARY_BYTES, parseRgPluginInfo, type RgPluginInfo, type RgPluginStatus } from '@qn/protocol'
import { WorkspaceError } from './workspace/registry'

const MAX_BASE64 = Math.ceil(MAX_RG_BINARY_BYTES / 3) * 4

function probeRgVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : /^ripgrep (\d+\.\d+\.\d+)(?:[\s+-]|$)/.exec(stdout)?.[1])
    })
  })
}

type SystemRg = { command: string; version: string }

export async function findSystemRg(): Promise<SystemRg | undefined> {
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    // 保留 PATH 顺序，搜索时使用已探测的绝对路径，避免工作区同名文件改变解析结果。
    if (!isAbsolute(directory)) continue
    const command = join(directory, name)
    if (!(await stat(command).catch(() => null))?.isFile()) continue
    const version = await probeRgVersion(command)
    if (version) return { command, version }
  }
  return undefined
}

export class RgPlugin {
  readonly #directory: string
  readonly #active: string
  readonly #platform = `${process.platform}-${process.arch}`
  #system?: { until: number; result: Promise<SystemRg | undefined> }
  #busy = false

  constructor(stateDir: string) {
    this.#directory = join(stateDir, 'plugins', 'rg')
    this.#active = join(this.#directory, 'active.json')
  }

  #systemRg(refresh = false): Promise<SystemRg | undefined> {
    if (refresh || !this.#system || Date.now() >= this.#system.until) {
      this.#system = { until: Date.now() + 30_000, result: findSystemRg() }
    }
    return this.#system.result
  }

  #binaryName(sha256: string): string {
    return `rg-${sha256}${process.platform === 'win32' ? '.exe' : ''}`
  }

  async #installed(): Promise<RgPluginInfo | null> {
    try {
      const info = parseRgPluginInfo(JSON.parse(await readFile(this.#active, 'utf8')))
      if (!info || info.platform !== this.#platform) return null
      return (await lstat(join(this.#directory, this.#binaryName(info.sha256)))).isFile() ? info : null
    } catch {
      return null
    }
  }

  async status(refresh = false): Promise<RgPluginStatus> {
    const [system, installed] = await Promise.all([this.#systemRg(refresh), this.#installed()])
    const platform = isRgPluginPlatform(this.#platform) ? this.#platform : null
    if (system) return { platform, source: 'system', version: system.version, ...(installed ? { installed } : {}) }
    return installed ? { platform, source: 'managed', version: installed.version, installed } : { platform, source: 'missing' }
  }

  async executables(): Promise<string[]> {
    const [system, installed] = await Promise.all([this.#systemRg(), this.#installed()])
    const candidates = system ? [system.command] : []
    if (installed) candidates.push(join(this.#directory, this.#binaryName(installed.sha256)))
    return candidates
  }

  async #change(update: () => Promise<void>): Promise<RgPluginStatus> {
    if (this.#busy) throw new WorkspaceError('conflict', '目标正在安装或移除插件，请稍后重试')
    this.#busy = true
    try {
      await update()
      return await this.status()
    } finally {
      this.#busy = false
    }
  }

  install(value: unknown, binary: unknown): Promise<RgPluginStatus> {
    return this.#change(async () => {
      const info = parseRgPluginInfo(value)
      if (!info || typeof binary !== 'string' || binary.length === 0 || binary.length > MAX_BASE64) {
        throw new WorkspaceError('params', '插件包格式无效')
      }
      if (info.platform !== this.#platform) throw new WorkspaceError('params', '插件平台与目标机不匹配')
      const bytes = Buffer.from(binary, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_RG_BINARY_BYTES || bytes.toString('base64') !== binary ||
          createHash('sha256').update(bytes).digest('hex') !== info.sha256) {
        throw new WorkspaceError('params', '插件 SHA-256 校验失败')
      }
      await mkdir(this.#directory, { recursive: true, mode: 0o700 })
      const installed = await this.#installed()
      if (installed?.sha256 === info.sha256 && installed.version === info.version) return
      const stage = await mkdtemp(join(this.#directory, '.stage-'))
      const name = this.#binaryName(info.sha256)
      try {
        const executable = join(stage, name)
        await writeFile(executable, bytes, { mode: 0o700, flag: 'wx' })
        if (await probeRgVersion(executable) !== info.version) {
          throw new WorkspaceError('params', '插件版本自检失败')
        }
        const manifest = join(stage, 'active.json')
        await writeFile(manifest, JSON.stringify(info), { mode: 0o600, flag: 'wx' })
        if (installed?.sha256 !== info.sha256) await rename(executable, join(this.#directory, name))
        // 指针最后替换，校验或自检失败时仍能使用原版本。
        await rename(manifest, this.#active)
        await this.#cleanBinaries(name)
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  remove(): Promise<RgPluginStatus> {
    return this.#change(async () => {
      await rm(this.#active, { force: true })
      await this.#cleanBinaries()
    })
  }

  async #cleanBinaries(keep?: string): Promise<void> {
    const files = await readdir(this.#directory).catch(() => [])
    // Windows 上仍在进行的搜索可能占用旧文件，下次操作时可再次清理。
    await Promise.all(files.filter((file) => file !== keep && /^rg-[a-f0-9]{64}(?:\.exe)?$/.test(file))
      .map((file) => rm(join(this.#directory, file), { force: true }).catch(() => undefined)))
  }
}
