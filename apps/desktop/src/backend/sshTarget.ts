import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { fingerprintFromKey } from './hostKeys'
import {
  buildConnectCommand,
  buildEnsureCommand,
  buildMkdirCommand,
  buildProbeCommand,
  buildShaCommand,
  buildUploadCommand,
  formatSize,
  parentPosixPath,
  parseEnsureResult,
  parseManifest,
  parseProbe,
  parseRemoteSha,
  redactToken,
  serverInstallPath,
  type EnsureResult,
  type RemoteProbe,
} from './remoteCommands'
import { ServerClient, toFramedStream } from './serverClient'
import type { SshLinkContext, TargetCredentials, TargetLink } from './types'

const READY_TIMEOUT_MS = 20_000
// 等待用户确认主机指纹的时间不计入握手超时；ssh2 自带的 readyTimeout 只作兜底上限。
const HOST_KEY_PROMPT_MAX_MS = 5 * 60_000
const KEEPALIVE_INTERVAL_MS = 15_000
const EXEC_TIMEOUT_MS = 30_000
const ENSURE_TIMEOUT_MS = 30_000
const MAX_EXEC_OUTPUT = 1024 * 1024

interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

interface ServerBundle {
  path: string
  bytes: Buffer
  sha256: string
  version: string
}

const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

function decorateSshError(err: Error, agent: boolean): Error {
  const level = (err as Error & { level?: string }).level
  const detail = redactToken(err.message)
  if (level === 'client-timeout') return new Error('SSH 握手超时（或主机指纹确认未在 20 秒内完成）')
  if (level === 'client-authentication' || /authentication/i.test(detail)) {
    const hint = agent
      ? `；请确认 ssh-agent 已运行（Windows 管道 ${WINDOWS_AGENT_PIPE}）`
      : '；请检查密码、私钥文件与口令'
    return new Error(`SSH 认证失败${hint}：${detail}`)
  }
  return new Error(`SSH 连接失败：${detail}`)
}

async function buildAuthConfig(
  target: SshLinkContext['target'],
  credentials: TargetCredentials
): Promise<{ config: Partial<ConnectConfig>; agent: boolean }> {
  switch (target.auth.kind) {
    case 'password': {
      if (!credentials.password) throw new Error('缺少 SSH 密码')
      return { config: { password: credentials.password }, agent: false }
    }
    case 'key': {
      let key: Buffer
      try {
        key = await readFile(target.auth.keyPath)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`无法读取 SSH 私钥文件：${detail}`)
      }
      return {
        config: {
          privateKey: key,
          ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
        },
        agent: false,
      }
    }
    case 'agent': {
      const pipe = process.platform === 'win32'
        ? WINDOWS_AGENT_PIPE
        : (process.env['SSH_AUTH_SOCK'] ?? '')
      if (!pipe) throw new Error('未找到 ssh-agent（SSH_AUTH_SOCK 未设置）')
      return { config: { agent: pipe }, agent: true }
    }
  }
}

function openSshClient(config: ConnectConfig, isPaused: () => boolean = () => false): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    // 自己计握手时间：指纹确认弹窗期间暂停计时。
    let elapsed = 0
    const watchdog = setInterval(() => {
      if (!isPaused()) elapsed += 500
      if (elapsed >= READY_TIMEOUT_MS) onError(new Error('Timed out while waiting for handshake'))
    }, 500)
    const onReady = (): void => {
      if (settled) return
      settled = true
      detach()
      resolve(client)
    }
    const onError = (err: Error): void => {
      if (settled) return
      settled = true
      detach()
      try {
        client.end()
      } catch {
        // 连接已经判定失败。
      }
      reject(decorateSshError(err, typeof config.agent === 'string'))
    }
    const onClose = (): void => {
      if (settled) return
      settled = true
      detach()
      reject(new Error('SSH 连接已关闭'))
    }
    const detach = (): void => {
      clearInterval(watchdog)
      client.removeListener('ready', onReady)
      client.removeListener('error', onError)
      client.removeListener('close', onClose)
    }
    client.on('ready', onReady)
    client.on('error', onError)
    client.on('close', onClose)
    client.connect(config)
  })
}

function execCommand(client: Client, command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let settled = false
    client.exec(command, (err, channel) => {
      if (err) {
        if (!settled) {
          settled = true
          reject(new Error(`远端命令执行失败：${redactToken(err.message)}`))
        }
        return
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try {
            channel.close()
          } catch {
            // 通道可能已经关闭。
          }
          reject(new Error('远端命令执行超时'))
        }
      }, timeoutMs)

      channel.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_EXEC_OUTPUT) stdout += chunk.toString('utf8')
      })
      channel.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_EXEC_OUTPUT) stderr += chunk.toString('utf8')
      })
      channel.on('exit', (code: unknown) => {
        if (typeof code === 'number') exitCode = code
      })
      channel.on('error', (cause: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`远端命令通道异常：${redactToken(cause.message)}`))
      })
      channel.on('close', () => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        resolve({ code: exitCode, stdout, stderr })
      })
    })
  })
}

async function execChecked(client: Client, command: string, timeoutMs?: number): Promise<ExecResult> {
  const result = await execCommand(client, command, timeoutMs)
  // stdout 可能含 ensure 的 token，失败信息只引用 stderr。
  if (result.code !== 0) {
    const detail = redactToken(result.stderr)
    throw new Error(`远端命令失败（退出码 ${String(result.code)}）${detail ? `：${detail}` : ''}`)
  }
  return result
}

function sftpUpload(client: Client, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`打开 SFTP 失败：${redactToken(err.message)}`))
        return
      }
      sftp.fastPut(localPath, remotePath, (cause) => {
        try {
          ;(sftp as unknown as { end(): void }).end()
        } catch {
          // SFTP 通道关闭失败不影响后续 mv。
        }
        if (cause) reject(new Error(`上传 server 失败：${redactToken(cause.message)}`))
        else resolve()
      })
    })
  })
}

async function readServerBundle(resourcesPath: string): Promise<ServerBundle> {
  const dir = join(resourcesPath, 'server')
  const manifest = parseManifest(JSON.parse(await readFile(join(dir, 'qn-server.json'), 'utf8')) as unknown)
  const path = join(dir, 'qn-server.cjs')
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  // 本地文件与清单不符时不上传，避免远端执行不可信二进制。
  if (sha256 !== manifest.sha256) throw new Error('本地 server 包校验失败，已取消部署')
  return { path, bytes, sha256, version: manifest.version }
}

interface Deployed {
  probe: RemoteProbe
  script: string
  ensure: EnsureResult
}

async function deployServer(client: Client, context: SshLinkContext, bundle: ServerBundle): Promise<Deployed> {
  context.hooks.onState('deploying', '检测远端环境')
  const probeResult = await execChecked(client, buildProbeCommand())
  const probe = parseProbe(probeResult.stdout)

  const script = serverInstallPath(probe.home, bundle.version, bundle.sha256)
  const dir = parentPosixPath(script)
  await execChecked(client, buildMkdirCommand(dir))
  const shaCommand = buildShaCommand(probe.sha256sumPath, script)

  let remoteSha = parseRemoteSha((await execChecked(client, shaCommand)).stdout)
  if (remoteSha !== bundle.sha256) {
    context.hooks.onState('deploying', `上传 server（${formatSize(bundle.bytes.byteLength)}）`)
    const tmp = `${dir}/.qn-server.cjs.tmp-${process.pid}-${Date.now()}`
    await sftpUpload(client, bundle.path, tmp)
    await execChecked(client, buildUploadCommand(tmp, script))
    remoteSha = parseRemoteSha((await execChecked(client, shaCommand)).stdout)
    if (remoteSha !== bundle.sha256) throw new Error('远端 server 校验失败，已拒绝启动')
  }

  context.hooks.onState('deploying', '启动 daemon')
  const ensured = await execChecked(client, buildEnsureCommand(probe.nodePath, script), ENSURE_TIMEOUT_MS)
  return { probe, script, ensure: parseEnsureResult(ensured.stdout) }
}

function openConnectChannel(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) reject(new Error(`启动 connect --stdio 失败：${redactToken(err.message)}`))
      else resolve(channel)
    })
  })
}

export async function connectSshTarget(context: SshLinkContext): Promise<TargetLink> {
  const { target, hooks, gate } = context
  hooks.onState('connecting', `连接 ${target.host}:${target.port}`)
  const auth = await buildAuthConfig(target, context.credentials)
  // 握手超时后 ssh2 会销毁 Client；迟到的指纹确认不能再回调已失效的 verify。
  let verifyingClient = true
  let promptPending = false
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: READY_TIMEOUT_MS + HOST_KEY_PROMPT_MAX_MS,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
      const decide = (accepted: boolean): void => {
        if (!verifyingClient) return
        try {
          verify(accepted)
        } catch {
          // 连接已判定失败，回调不再有意义。
        }
      }
      promptPending = true
      void gate
        .verify(target.host, target.port, fingerprintFromKey(key))
        .then(decide)
        .catch(() => decide(false))
        .finally(() => {
          promptPending = false
        })
    },
    ...auth.config,
  }

  const client = await openSshClient(config, () => promptPending)
  let closed = false
  let userClosed = false
  let channelStderr = ''
  // 握手前就要有 error 监听：部署期间 SSH 断开时不能让未处理的 error 事件打挂 backend。
  const finish = (err?: Error): void => {
    if (closed) return
    closed = true
    verifyingClient = false
    if (!userClosed) {
      try {
        client.end()
      } catch {
        // SSH 连接可能已经断开。
      }
    }
    hooks.onClose(err ?? (channelStderr ? new Error(redactToken(channelStderr)) : undefined))
  }
  client.on('error', (err: Error) => finish(err))
  client.on('close', () => finish(new Error('SSH 连接已断开')))

  try {
    const bundle = await readServerBundle(context.resourcesPath)
    const deployed = await deployServer(client, context, bundle)
    const channel = await openConnectChannel(
      client,
      buildConnectCommand(deployed.probe.nodePath, deployed.script)
    )
    channel.stderr.on('data', (chunk: Buffer) => {
      if (channelStderr.length < 4096) channelStderr += chunk.toString('utf8')
    })
    const server = await ServerClient.connect({
      stream: toFramedStream(channel),
      token: deployed.ensure.token,
      clientVersion: context.appVersion,
      requestTimeoutMs: 60_000,
      handlers: {
        onEvent: hooks.onEvent,
        onCodexRecv: hooks.onCodexRecv,
        onClose: (err) => finish(err),
      },
    })

    return {
      request: (method, params) => server.request(method, params),
      codexSend: (msg, agent) => server.codexSend(msg, agent),
      close: () => {
        userClosed = true
        server.close()
        try {
          channel.close()
        } catch {
          // 通道可能已随 server 客户端关闭。
        }
        try {
          client.end()
        } catch {
          // 连接可能已经断开。
        }
      },
    }
  } catch (err) {
    verifyingClient = false
    closed = true
    try {
      client.end()
    } catch {
      // 连接可能已经断开。
    }
    throw err
  }
}
