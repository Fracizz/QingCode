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

export interface ResolveOptions {
  exists?: (file: string) => boolean
  versionOf?: (file: string) => string
}

const VERSION_TIMEOUT_MS = 3_000

export function claudeCandidates(explicit?: string): string[] {
  if (explicit) return [explicit]
  const isWindows = process.platform === 'win32'
  // Windows 优先 .exe；.cmd 需要 shell 且 SDK 不接受，故不列入。
  const names = isWindows ? ['claude.exe', 'claude'] : ['claude']
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
  for (const candidate of claudeCandidates(explicit)) {
    if (!exists(candidate)) continue
    return { path: candidate, version: versionOf(candidate) }
  }
  throw new AgentHostError(
    'agent_unavailable',
    `未找到 claude${explicit ? ` (${explicit})` : ''}；请在目标机安装并登录 Claude Code，或用 claudePath 指定可执行文件`,
  )
}
