/** claude 可执行文件解析：只找目标机上已安装并登录的 claude，不用 SDK 自带的原生二进制。 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentHostError } from '../codexHost'

export interface ClaudeExecutable {
  path: string
  version: string
}

export interface ClaudeResolveEnv {
  platform: string
  pathValue: string
  delimiter: string
  home: string
  appData?: string
  localAppData?: string
}

export function defaultClaudeResolveEnv(): ClaudeResolveEnv {
  return {
    platform: process.platform,
    pathValue: process.env['PATH'] ?? '',
    delimiter: path.delimiter,
    home: os.homedir(),
    ...(process.env['APPDATA'] ? { appData: process.env['APPDATA'] } : {}),
    ...(process.env['LOCALAPPDATA'] ? { localAppData: process.env['LOCALAPPDATA'] } : {}),
  }
}

export interface ResolveOptions {
  exists?: (file: string) => boolean
  versionOf?: (file: string) => string
  env?: ClaudeResolveEnv
}

const VERSION_TIMEOUT_MS = 3_000

/**
 * 只列目标机已安装的官方 claude：Windows 优先 .exe（SDK 不接受 .cmd），
 * PATH 之外补上 ~/.local/bin（验收机 10.87）、npm 全局与 WindowsApps 常见安装位置。
 */
export function claudeCandidates(
  explicit?: string,
  env: ClaudeResolveEnv = defaultClaudeResolveEnv(),
): string[] {
  if (explicit) return [explicit]
  const win = env.platform === 'win32'
  const p = win ? path.win32 : path.posix
  const names = win ? ['claude.exe', 'claude'] : ['claude']
  const dirs = env.pathValue.split(env.delimiter).filter(Boolean)
  const extras = win
    ? [
        p.join(env.home, '.local', 'bin'),
        ...(env.appData ? [p.join(env.appData, 'npm')] : []),
        ...(env.localAppData ? [p.join(env.localAppData, 'Programs')] : []),
        ...(env.localAppData
          ? [p.join(env.localAppData, 'Microsoft', 'WindowsApps')]
          : []),
      ]
    : [
        p.join(env.home, '.local', 'bin'),
        '/usr/local/bin',
        p.join(env.home, '.npm-global', 'bin'),
      ]
  const result: string[] = []
  const seen = new Set<string>()
  for (const dir of [...dirs, ...extras]) {
    for (const name of names) {
      const candidate = p.join(dir, name)
      const key = win ? candidate.toLowerCase() : candidate
      if (seen.has(key)) continue
      seen.add(key)
      result.push(candidate)
    }
  }
  return result
}

export function readClaudeVersion(file: string): string {
  try {
    const result = spawnSync(file, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    })
    if (result.status !== 0 && !result.stdout) return 'unknown'
    return `${result.stdout ?? ''}`.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function resolveClaudeExecutable(
  explicit?: string,
  options: ResolveOptions = {},
): ClaudeExecutable {
  const exists = options.exists ?? ((file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  const versionOf = options.versionOf ?? readClaudeVersion
  for (const candidate of claudeCandidates(explicit, options.env)) {
    if (!exists(candidate)) continue
    return { path: candidate, version: versionOf(candidate) }
  }
  throw new AgentHostError(
    'agent_unavailable',
    `未找到 claude${explicit ? ` (${explicit})` : ''}；请在目标机安装并登录 Claude Code，或用 claudePath 指定可执行文件`,
  )
}
