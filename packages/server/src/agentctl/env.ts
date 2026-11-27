/** 让 daemon 拉起的 Agent / 终端能直接运行 `qn`：写启动脚本、准备环境变量（只动进程环境，不碰 Agent 协议）。 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const QN_ENV = {
  endpoint: 'QN_ENDPOINT',
  token: 'QN_AGENT_TOKEN',
  cli: 'QN_CLI',
} as const

export interface ShimSpec {
  /** 运行 qn-server.cjs 的解释器（node 或以 node 模式运行的 Electron） */
  execPath: string
  script: string
  /** 本进程是 Electron 以 node 模式运行时，子进程也必须带上，否则会拉起一个 Electron 窗口进程。 */
  electronAsNode: boolean
}

export function shimScripts(spec: ShimSpec): { cmd: string; sh: string } {
  const cmd = [
    '@echo off',
    'setlocal',
    ...(spec.electronAsNode ? ['set ELECTRON_RUN_AS_NODE=1'] : []),
    `"${spec.execPath}" "${spec.script}" qn %*`,
    '',
  ].join('\r\n')
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  const sh = [
    '#!/bin/sh',
    `${spec.electronAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${quote(spec.execPath)} ${quote(spec.script)} qn "$@"`,
    '',
  ].join('\n')
  return { cmd, sh }
}

/** 写入 <runDir>/bin/qn(.cmd)，返回目录与当前平台应调用的脚本路径。 */
export function installShim(runDir: string, spec: ShimSpec, platform = process.platform): { binDir: string; cli: string } {
  const binDir = path.join(runDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const { cmd, sh } = shimScripts(spec)
  const cmdPath = path.join(binDir, 'qn.cmd')
  const shPath = path.join(binDir, 'qn')
  // Windows 上 Git Bash 等 POSIX shell 也会用到无扩展名的 sh 版本，两份都写。
  fs.writeFileSync(cmdPath, cmd)
  fs.writeFileSync(shPath, sh, { mode: 0o755 })
  if (platform !== 'win32') fs.chmodSync(shPath, 0o755)
  return { binDir, cli: platform === 'win32' ? cmdPath : shPath }
}

export function newAgentToken(): string {
  return randomBytes(24).toString('hex')
}

/** Windows 的环境变量名不区分大小写，PATH 可能叫 Path；返回实际使用的键。 */
export function pathKey(env: NodeJS.ProcessEnv, platform = process.platform): string {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path'
}

export function applyAgentEnv(
  env: NodeJS.ProcessEnv,
  values: { endpoint: string; token: string; binDir: string; cli: string },
  platform = process.platform,
): void {
  env[QN_ENV.endpoint] = values.endpoint
  env[QN_ENV.token] = values.token
  env[QN_ENV.cli] = values.cli
  const key = pathKey(env, platform)
  const delimiter = platform === 'win32' ? ';' : ':'
  const parts = (env[key] ?? '').split(delimiter).filter((part) => part && part !== values.binDir)
  env[key] = [values.binDir, ...parts].join(delimiter)
}
