/**
 * pi 可执行文件解析：只驱动目标机上用户自己安装、自己登录的 pi。
 * 探测只允许 --version；不下载、不安装、不升级，也不读 pi 的认证/模型配置。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentHostError } from '../codexHost'

export interface PiCommand {
  command: string
  args: string[]
  shell: boolean
}

export interface PiExecutable extends PiCommand {
  path: string
  version: string
}

export interface ResolveOptions {
  exists?: (file: string) => boolean
  versionOf?: (file: string, spec: PiCommand) => string
  platform?: NodeJS.Platform
}

const VERSION_TIMEOUT_MS = 3_000

/** Windows 的 npm 安装会给出 pi.cmd / pi.ps1，POSIX 通常只有 pi。 */
export function piCandidates(explicit?: string, platform: NodeJS.Platform = process.platform): string[] {
  if (explicit) return [explicit]
  const isWindows = platform === 'win32'
  const names = isWindows ? ['pi.exe', 'pi.cmd', 'pi.ps1', 'pi'] : ['pi']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const home = os.homedir()
  const result: string[] = []
  for (const dir of dirs) for (const name of names) result.push(path.join(dir, name))
  for (const name of names) result.push(path.join(home, '.local', 'bin', name))
  for (const dir of ['/usr/local/bin', path.join(home, '.npm-global', 'bin')]) {
    for (const name of names) result.push(path.join(dir, name))
  }
  return result
}

/** .cmd 必须经 cmd.exe；.ps1 用 powershell -File；其余直接 spawn，不经 shell。 */
export function wrapPiCommand(file: string, platform: NodeJS.Platform = process.platform): PiCommand {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { command: `"${file.replace(/"/g, '')}"`, args: [], shell: true }
  }
  if (platform === 'win32' && /\.ps1$/i.test(file)) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      shell: false,
    }
  }
  return { command: file, args: [], shell: false }
}

/** 唯一的可用性探测；spawnSync 的 stderr 不进日志（可能含用户环境信息）。 */
export function readPiVersion(file: string, spec: PiCommand = wrapPiCommand(file)): string {
  try {
    const result = spawnSync(spec.command, [...spec.args, '--version'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
      shell: spec.shell,
    })
    const text = `${result.stdout ?? ''}`
    return text.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 测试钩子：piPath 为 JSON 数组字符串时按 [可执行文件, ...参数] 原样启动，
 * 便于用假 pi 脚本跑端到端；此路径不做 --version 探测，version 记为 test。
 */
export function resolvePiExecutable(
  explicit?: string,
  options: ResolveOptions = {},
): PiExecutable {
  const trimmed = typeof explicit === 'string' ? explicit.trim() : ''
  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new AgentHostError('agent_unavailable', 'piPath 数组不是合法 JSON')
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      typeof parsed[0] !== 'string' ||
      parsed[0].length === 0 ||
      !parsed.every((item) => typeof item === 'string')
    ) {
      throw new AgentHostError('agent_unavailable', 'piPath 数组必须是 [可执行文件, ...参数]')
    }
    return {
      command: parsed[0],
      args: parsed.slice(1) as string[],
      shell: false,
      path: parsed[0],
      version: 'test',
    }
  }

  const platform = options.platform ?? process.platform
  const exists = options.exists ?? ((file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  const versionOf = options.versionOf ?? readPiVersion
  for (const candidate of piCandidates(trimmed || undefined, platform)) {
    if (!exists(candidate)) continue
    const spec = wrapPiCommand(candidate, platform)
    return { ...spec, path: candidate, version: versionOf(candidate, spec) }
  }
  throw new AgentHostError(
    'agent_unavailable',
    `未找到 pi${trimmed ? ` (${trimmed})` : ''}；请在目标机用其原有安装方式安装并登录 pi，或用 piPath 指定可执行文件`,
  )
}
