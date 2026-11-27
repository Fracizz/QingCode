/**
 * 远端真机验收：部署 server → ping → fs.home → codex.open。新主机指纹自动接受，
 * 指纹变化仍然拒绝（不会覆盖 known_hosts）。
 *
 * 仓库根执行（tsx 未安装，用 esbuild 打包；ssh2 保持 external 以免打包可选原生模块）：
 *   pnpm build:server
 *   pnpm exec esbuild apps/desktop/src/backend/dev/smoke-ssh.ts --bundle --platform=node --format=esm --external:ssh2 --external:cpu-features --outfile=apps/desktop/.dev/smoke-ssh.mjs
 *   node apps/desktop/.dev/smoke-ssh.mjs 192.168.10.93 22 root C:/Users/Administrator/.ssh/id_ed25519
 * 或用 vitest：
 *   QN_SMOKE_SSH="192.168.10.93 22 root C:/Users/Administrator/.ssh/id_ed25519" pnpm exec vitest run apps/desktop/src/backend/dev/smoke-ssh.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshTarget } from '../../shared/backendApi'
import { backendConfig } from '../config'
import { TargetManager } from '../targets'

export interface SshSmokeArgs {
  host: string
  port: number
  username: string
  keyPath: string
}

export interface SshSmokeOptions extends Partial<SshSmokeArgs> {
  userData?: string
  resourcesPath?: string
  emit?: (name: string, payload: unknown) => void
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export function parseSmokeArgs(argv: readonly string[]): SshSmokeArgs {
  const [host, portText, username, ...rest] = argv
  const keyPath = rest.join(' ')
  const port = Number(portText)
  if (!host || !portText || !username || !keyPath || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('用法: smoke-ssh <host> <port> <user> <keyPath>')
  }
  return { host, port, username, keyPath }
}

export async function runSshSmoke(args: SshSmokeArgs, options: SshSmokeOptions = {}): Promise<void> {
  const root = process.cwd()
  const resourcesPath = options.resourcesPath ?? process.env['QN_RESOURCES_PATH'] ??
    join(root, 'apps', 'desktop', 'resources')
  const temporary = options.userData || backendConfig.userData
    ? null
    : await mkdtemp(join(tmpdir(), 'qn-smoke-ssh-'))
  const userData = options.userData ?? (backendConfig.userData || temporary) ?? ''
  const target: SshTarget = {
    id: `smoke-ssh-${args.host}-${args.port}`,
    kind: 'ssh',
    name: `smoke-${args.host}`,
    host: args.host,
    port: args.port,
    username: args.username,
    auth: { kind: 'key', keyPath: args.keyPath },
  }
  const manager = new TargetManager({
    userData,
    resourcesPath,
    electronPath: backendConfig.electronPath,
    appVersion: backendConfig.appVersion,
    autoAcceptHostKey: true,
    emit: (name, payload) => {
      options.emit?.(name, payload)
      if (name === 'target.state') {
        const state = payload as { state: string; detail?: string }
        console.log(`[target.state] ${state.state}${state.detail ? ` ${state.detail}` : ''}`)
      } else if (name === 'hostKey.prompt') {
        const prompt = payload as { kind: string; fingerprint: string }
        console.log(`[hostKey.prompt] ${prompt.kind} ${prompt.fingerprint}`)
      }
    },
  })

  try {
    await manager.connect(target, {})
    await manager.waitUntilReady(target.id, 90_000)
    const ping = await manager.request(target.id, 'ping')
    const home = await manager.request(target.id, 'fs.home')
    if (!isRecord(home) || typeof home.path !== 'string') throw new Error('fs.home 返回结果无效')
    const status = await manager.request(target.id, 'codex.status')
    const opened = await manager.request(target.id, 'codex.open', {})
    const open = isRecord(opened)
      ? { lastSeq: opened['lastSeq'], codexVersion: opened['codexVersion'], initialize: summarize(opened['initialize']) }
      : opened
    console.log('远端 smoke 通过：')
    console.log(JSON.stringify({ target: { host: args.host, port: args.port, username: args.username }, ping, home, status, open }, null, 2))
  } finally {
    manager.shutdown()
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}

function summarize(value: unknown): unknown {
  if (!isRecord(value)) return value
  return Object.keys(value)
}

// 打包后由入口文件名判断，避免被其他脚本 import 时误跑 CLI。
function isMain(): boolean {
  const entry = process.argv[1] ?? ''
  return /(?:^|[\\/])smoke-ssh\.(?:mjs|js|cjs|ts)$/.test(entry)
}

if (isMain()) {
  try {
    const args = parseSmokeArgs(process.argv.slice(2))
    void runSshSmoke(args).catch((err: unknown) => {
      console.error(`远端 smoke 失败：${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
