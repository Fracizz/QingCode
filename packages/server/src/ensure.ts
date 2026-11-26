import { spawn } from 'node:child_process'
import path from 'node:path'
import { IpcClient, IpcRequestError } from './client'
import {
  ensureRunDir,
  readDaemonJson,
  readToken,
  resolvePaths,
  type ServerPaths,
} from './paths'
import { VERSION } from './version'
import { needsJobBreakaway, spawnOutsideJob } from './windowsDetach'

export interface EnsureOptions {
  stateDir?: string
  replace?: boolean
  timeoutMs?: number
  /** 测试可覆盖：默认取当前进程运行的脚本路径。 */
  scriptPath?: string
  spawnProgram?: string
}

export interface EnsureResult {
  token: string
  version: string
  pid: number
  started: boolean
  /** 本地 IPC 地址（Windows 命名管道 / POSIX socket），本机客户端直接连它，避免复制命名规则。 */
  endpoint: string
  /** 要求替换但旧版 daemon 仍有进行中的任务/终端，暂时沿用旧版；只在为 true 时出现。 */
  stale?: true
}

interface Probe {
  client: IpcClient
  serverVersion: string
}

const PROBE_TIMEOUT_MS = 700
const RETRY_INTERVAL_MS = 100
const EXIT_WAIT_MS = 5_000

export async function ensure(options: EnsureOptions = {}): Promise<EnsureResult> {
  const paths = resolvePaths(options.stateDir)
  ensureRunDir(paths)
  // daemon.json 可能是崩溃后残留的陈旧文件，是否活着以真实握手为准。
  void readDaemonJson(paths)

  let probe = await probeDaemon(paths)
  if (probe) {
    if (options.replace && probe.serverVersion !== VERSION) {
      if (!(await requestIdleShutdown(probe.client))) return finish(probe, paths, false, undefined, true)
      probe.client.close()
      probe = await waitForExit(paths)
      if (probe) return finish(probe, paths, false, undefined, probe.serverVersion !== VERSION)
      // Windows 命名管道实例释放会略晚于进程退出。
      await sleep(RETRY_INTERVAL_MS)
    } else {
      return finish(probe, paths, false)
    }
  }

  spawnDaemon(paths, options)
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  while (Date.now() < deadline) {
    const ready = await probeDaemon(paths)
    if (ready) {
      const token = readToken(paths)
      if (token) return finish(ready, paths, true, token)
      ready.client.close()
    }
    await sleep(RETRY_INTERVAL_MS)
  }
  throw new Error('daemon 启动超时')
}

function finish(
  probe: Probe,
  paths: ServerPaths,
  started: boolean,
  token = readToken(paths),
  stale = false,
): EnsureResult {
  const result: EnsureResult = {
    token: token ?? '',
    version: probe.serverVersion,
    pid: probe.client.pid,
    started,
    endpoint: paths.endpoint,
    ...(stale ? { stale: true as const } : {}),
  }
  probe.client.close()
  return result
}

async function probeDaemon(paths: ServerPaths): Promise<Probe | null> {
  const token = readToken(paths)
  if (!token) return null
  let client: IpcClient | null = null
  try {
    client = await IpcClient.connect(paths, token, PROBE_TIMEOUT_MS)
    const ping = (await client.request('ping', undefined, PROBE_TIMEOUT_MS)) as {
      serverVersion?: unknown
    } | null
    const serverVersion = typeof ping?.serverVersion === 'string' ? ping.serverVersion : VERSION
    return { client, serverVersion }
  } catch {
    client?.close()
    return null
  }
}

async function requestIdleShutdown(client: IpcClient): Promise<boolean> {
  try {
    const status = await client.request('codex.status', undefined, PROBE_TIMEOUT_MS) as {
      activeTurns?: unknown
    } | null
    if (status?.activeTurns !== 0) return false
    // 有些旧版支持终端，但还不会按 whenIdle 拒绝替换请求。
    const terminalState = await client.request('term.list', undefined, PROBE_TIMEOUT_MS).catch((err: unknown) => {
      if (err instanceof IpcRequestError && err.code === 'method') return { terminals: [] }
      throw err
    }) as { terminals?: Array<{ alive?: unknown }> } | null
    if (!Array.isArray(terminalState?.terminals) || terminalState.terminals.some((term) => term.alive !== false)) {
      return false
    }
    await client.request('server.shutdown', { whenIdle: true }, PROBE_TIMEOUT_MS)
    return true
  } catch {
    // 无法确认旧进程已接受关闭时，先维持现有连接。
    return false
  }
}

async function waitForExit(paths: ServerPaths): Promise<Probe | null> {
  const deadline = Date.now() + EXIT_WAIT_MS
  while (Date.now() < deadline) {
    const probe = await probeDaemon(paths)
    if (!probe) return null
    probe.client.close()
    await sleep(RETRY_INTERVAL_MS)
  }
  return probeDaemon(paths)
}

function spawnDaemon(paths: ServerPaths, options: EnsureOptions): void {
  const script = options.scriptPath ?? path.resolve(process.argv[1] ?? 'qn-server.cjs')
  const args = [script, 'daemon', '--state-dir', paths.stateDir]
  const program = options.spawnProgram ?? process.execPath
  if (needsJobBreakaway() && spawnOutsideJob(program, args)) return
  const child = spawn(program, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // 本机 Electron 以 ELECTRON_RUN_AS_NODE=1 运行，子 daemon 必须继承该变量。
    env: { ...process.env },
  })
  child.on('error', (err: Error) => {
    process.stderr.write(`qn-server ensure: 无法拉起 daemon: ${err.message}\n`)
  })
  child.unref()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
