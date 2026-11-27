import { spawn } from 'node:child_process'
import net from 'node:net'
import { STALE_SERVER_NOTICE, parseEnsureResult, redactToken, type EnsureResult } from './remoteCommands'
import { ServerClient, toFramedStream } from './serverClient'
import type { LocalLinkContext, TargetLink } from './types'

const DEFAULT_ENSURE_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** ensure 用 Electron 自带 Node 运行，stdout 只含一行 JSON（含 token，绝不写日志）。 */
export function runLocalEnsure(
  electronPath: string,
  serverScript: string,
  timeoutMs = DEFAULT_ENSURE_TIMEOUT_MS
): Promise<EnsureResult> {
  return new Promise((resolve, reject) => {
    // --replace：安装新版后若旧版 daemon 仍在（且空闲），换成新版，否则会一直跑旧代码。
    const child = spawn(electronPath, [serverScript, 'ensure', '--replace'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill()
      reject(new Error('本机 daemon 启动超时'))
    }, timeoutMs)

    const fail = (message: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(message))
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => fail(`本机 daemon 启动失败: ${redactToken(err.message)}`))
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const detail = redactToken(stderr)
      if (code !== 0) {
        reject(new Error(`本机 daemon 启动失败 (退出码 ${String(code)})${detail ? `: ${detail}` : ''}`))
        return
      }
      try {
        resolve(parseEnsureResult(stdout))
      } catch (err) {
        reject(new Error(err instanceof Error ? err.message : '本机 daemon 启动结果无效'))
      }
    })
  })
}

export function openEndpoint(endpoint: string, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('连接本机 daemon 超时'))
    }, timeoutMs)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(new Error(`连接本机 daemon 失败: ${redactToken(err.message)}`))
    })
  })
}

export async function connectLocalTarget(context: LocalLinkContext): Promise<TargetLink> {
  context.hooks.onState('connecting', '启动本机 daemon')
  const ensure = await runLocalEnsure(context.electronPath, context.serverScript)
  // endpoint 由 ensure 直接给出，不在 backend 复制命名管道规则。
  const socket = await openEndpoint(ensure.endpoint)
  try {
    const server = await ServerClient.connect({
      stream: toFramedStream(socket),
      token: ensure.token,
      clientVersion: context.appVersion,
      requestTimeoutMs: 60_000,
      handlers: {
        onEvent: context.hooks.onEvent,
        onCodexRecv: context.hooks.onCodexRecv,
        onClose: context.hooks.onClose,
      },
    })
    return {
      ...(ensure.stale ? { notice: STALE_SERVER_NOTICE } : {}),
      request: (method, params) => server.request(method, params),
      codexSend: (msg, agent) => server.codexSend(msg, agent),
      close: () => {
        server.close()
        socket.destroy()
      },
    }
  } catch (err) {
    socket.destroy()
    throw err
  }
}
