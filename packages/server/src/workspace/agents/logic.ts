import path from 'node:path'
import type { WorkspaceMethods } from '@qn/protocol'

// agent.probe 的纯逻辑：参数校验、可执行文件解析、版本输出解析、命令拼装。
// 合规 §7：探测只允许文件存在性检查与 `<exe> --version`，不开会话、不发 prompt、不碰凭据。

export type ProbeAgent = WorkspaceMethods['agent.probe']['params']['agent']
export type ProbeParams = WorkspaceMethods['agent.probe']['params']
export type ProbeResult = WorkspaceMethods['agent.probe']['result']

export const PROBE_AGENTS: readonly ProbeAgent[] = ['codex', 'claude', 'pi']

const MAX_PATH_LENGTH = 4096

export function isProbeAgent(value: unknown): value is ProbeAgent {
  return value === 'codex' || value === 'claude' || value === 'pi'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 只接受白名单字段；非法值返回 null 让 handler 报 params 错误，不把原始对象带到子进程。 */
export function parseProbeParams(raw: Record<string, unknown>): ProbeParams | null {
  if (!isProbeAgent(raw.agent)) return null
  const rawPath = raw.path
  if (rawPath === undefined || rawPath === null) return { agent: raw.agent }
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (trimmed.length > MAX_PATH_LENGTH || trimmed.includes('\0')) return null
  return trimmed ? { agent: raw.agent, path: trimmed } : { agent: raw.agent }
}

export type ProbeEnv = {
  platform: string
  /** PATH 原始值 */
  pathValue: string
  home: string
  /** path.delimiter，显式传入便于跨平台单测 */
  delimiter: string
  localAppData?: string
}

/**
 * Windows 下 Claude 只认 .exe（mvp §11.1：不用 .cmd）；Codex / pi 的 npm 安装形态含 .cmd。
 * .ps1 / 裸脚本无法直接 spawn，不列为候选；POSIX 下只有裸名字，交给 PATH 解析。
 */
export function agentExecutableNames(agent: ProbeAgent, platform: string): string[] {
  if (platform !== 'win32') return [agent]
  switch (agent) {
    case 'codex':
      return ['codex.exe', 'codex.cmd', 'codex.bat']
    case 'claude':
      return ['claude.exe', 'claude']
    case 'pi':
      return ['pi.exe', 'pi.cmd']
  }
}

/** 解析顺序：参数 → PATH → 常见安装目录 → 裸名字（由 spawn 再按 PATH 兜底）。 */
export function probeCandidates(
  agent: ProbeAgent,
  explicit: string | undefined,
  env: ProbeEnv,
): string[] {
  if (explicit) return [explicit]
  const p = env.platform === 'win32' ? path.win32 : path.posix
  const names = agentExecutableNames(agent, env.platform)
  const dirs = env.pathValue.split(env.delimiter).filter(Boolean)
  const extra =
    env.platform === 'win32'
      ? [
          p.join(env.home, '.local', 'bin'),
          ...(env.localAppData ? [p.join(env.localAppData, 'Programs')] : []),
        ]
      : [
          p.join(env.home, '.local', 'bin'),
          '/usr/local/bin',
          p.join(env.home, '.npm-global', 'bin'),
        ]
  const result: string[] = []
  for (const dir of [...dirs, ...extra]) {
    for (const name of names) {
      const candidate = p.join(dir, name)
      if (!result.includes(candidate)) result.push(candidate)
    }
  }
  for (const name of names) if (!result.includes(name)) result.push(name)
  return result
}

/** 版本行形如 `codex-cli 0.172.0` / `2.1.331 (Claude Code)`；只取第一段语义化版本号。 */
export function parseProbeVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0]
}

export type VersionCommand = {
  command: string
  args: string[]
  /** Windows 下 cmd.exe 分支要求参数原样传递 */
  verbatim: boolean
}

/**
 * 只拼 `--version`，不经过 shell。Windows 的 .cmd/.bat 必须由 cmd.exe 启动，
 * 路径里的引号先去掉，避免用户填的路径借引号注入额外命令。
 */
export function buildVersionCommand(
  file: string,
  platform: string,
  comspec = 'cmd.exe',
): VersionCommand {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const clean = file.replace(/"/g, '')
    return {
      command: comspec,
      args: ['/d', '/s', '/c', `"${clean}" --version`],
      verbatim: true,
    }
  }
  return { command: file, args: ['--version'], verbatim: false }
}

export type VersionRun = {
  status: number | null
  stdout: string
  stderr: string
  errorCode?: string
  timedOut: boolean
}

export type VersionOutcome =
  | { ok: true; version?: string }
  | { ok: false; error: string }

/** 错误文案固定，不回传子进程原始输出（`--version` 输出也不进日志）。 */
export function classifyVersionRun(run: VersionRun): VersionOutcome {
  if (run.timedOut || run.errorCode === 'ETIMEDOUT') {
    return { ok: false, error: '执行 --version 超时' }
  }
  if (run.errorCode === 'ENOENT') return { ok: false, error: '未找到可执行文件' }
  if (run.errorCode === 'EACCES' || run.errorCode === 'EPERM') {
    return { ok: false, error: '没有执行权限' }
  }
  if (run.errorCode) return { ok: false, error: '无法运行 --version' }
  const version = parseProbeVersion(`${run.stdout}\n${run.stderr}`)
  // 有些 CLI 用非零码输出版本；只有既非零又没有版本号才算探测失败。
  if (run.status !== 0 && !version) {
    return { ok: false, error: '可执行文件返回非零状态' }
  }
  return version ? { ok: true, version } : { ok: true }
}

/** 裸名字不做文件存在性检查，交给 spawn 按 PATH 解析。 */
export function isBareName(candidate: string): boolean {
  return !/[\\/]/.test(candidate)
}
