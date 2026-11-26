import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { TargetProbe } from '../shared/backendApi'
import { backendConfig } from './config'
import { fingerprintFromKey } from './hostKeys'
import {
  buildConnectCommand,
  buildEnsureCommand,
  buildMkdirCommand,
  buildProbeCommand,
  buildServerCommand,
  buildShaCommand,
  buildUploadCommand,
  buildRuntimeInstallCommand,
  buildRuntimeSelfTestCommand,
  buildWindowsConnectCommand,
  buildWindowsEnsureCommand,
  buildWindowsMkdirCommand,
  buildWindowsProbeCommand,
  buildWindowsServerCommand,
  buildWindowsShaCommand,
  buildWindowsUploadCommand,
  formatSize,
  isPosixProbe,
  parentPosixPath,
  parseEnsureResult,
  STALE_SERVER_NOTICE,
  parseJsonLine,
  parseManifest,
  parseProbe,
  parseRemoteSha,
  parseRuntimeManifest,
  parseWindowsProbe,
  redactToken,
  runtimeInstallPath,
  runtimeTargetKey,
  serverInstallPath,
  type EnsureResult,
  type RemoteProbe,
  type RuntimeManifest,
  windowsSftpPath,
} from './remoteCommands'
import { ServerClient, toFramedStream } from './serverClient'
import type { SshLinkContext, SshRemoteContext, SshTestContext, TargetCredentials, TargetLink } from './types'

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
    // ssh2 在首个 error 之后仍可能再抛（如认证失败后紧跟 ECONNRESET）；没有监听器会直接打挂整个 backend。
    client.on('error', () => undefined)
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

function sftpUpload(client: Client, localPath: string, remotePath: string, label = '上传 server 失败'): Promise<void> {
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
        if (cause) reject(new Error(`${label}：${redactToken(cause.message)}`))
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

const NODE_REQUIRED_TEST = '远端需要 Node ≥ 18'
const NODE_REQUIRED_DEPLOY = '远端需要 Node ≥ 18（请确认 node 在 SSH 会话的 PATH 中）'

interface RuntimeCandidate {
  version: string
  file: string
  sha256: string
}

/** 清单不存在时返回 null，让调用方退回「需要 Node ≥ 18」的原有提示。 */
async function readRuntimeManifest(resourcesPath: string): Promise<RuntimeManifest | null> {
  let raw: string
  try {
    raw = await readFile(join(resourcesPath, 'node-runtime', 'manifest.json'), 'utf8')
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return null
    throw cause
  }
  return parseRuntimeManifest(JSON.parse(raw) as unknown)
}

async function findRuntimeCandidate(
  resourcesPath: string,
  os: string,
  arch: string
): Promise<RuntimeCandidate | null> {
  const key = runtimeTargetKey(os, arch)
  if (!key) return null
  const manifest = await readRuntimeManifest(resourcesPath)
  const entry = manifest?.targets[key]
  if (!manifest || !entry) return null
  return { version: manifest.version, file: entry.file, sha256: entry.sha256 }
}

/** 推送内置 Node 到内容寻址目录并自检能否执行；返回供后续命令使用的 node 路径与版本。 */
async function installRuntimeNode(
  client: Client,
  onState: (detail: string) => void,
  probe: RemoteProbe,
  resourcesPath: string
): Promise<{ nodePath: string; nodeVersion: string }> {
  const candidate = await findRuntimeCandidate(resourcesPath, probe.os, probe.arch)
  if (!candidate) throw new Error(NODE_REQUIRED_DEPLOY)

  const localPath = join(resourcesPath, 'node-runtime', candidate.file)
  const bytes = await readFile(localPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== candidate.sha256) throw new Error('内置 Node 校验失败，已取消部署')

  const nodePath = runtimeInstallPath(probe.home, sha256)
  const dir = parentPosixPath(nodePath)
  // 只在 POSIX 分支推送，直接复用同一套 mkdir / sha / 安装命令构造器。
  await execChecked(client, buildMkdirCommand(dir))
  const shaCommand = buildShaCommand(probe.sha256sumPath, nodePath)
  let remoteSha = parseRemoteSha((await execChecked(client, shaCommand)).stdout)
  if (remoteSha !== sha256) {
    onState(`上传 Node 运行时（${formatSize(bytes.byteLength)}）`)
    const tmp = `${dir}/.node.tmp-${process.pid}-${Date.now()}`
    await sftpUpload(client, localPath, tmp, '上传 Node 运行时失败')
    await execChecked(client, buildRuntimeInstallCommand(tmp, nodePath))
    remoteSha = parseRemoteSha((await execChecked(client, shaCommand)).stdout)
    if (remoteSha !== sha256) throw new Error('内置 Node 校验失败，已取消部署')
  }

  const selfTest = await execCommand(client, buildRuntimeSelfTestCommand(nodePath))
  if (!selfTest.stdout.includes('QN_NODE_OK')) {
    throw new Error('远端无法执行内置 Node（目录可能挂载为 noexec）')
  }
  return { nodePath, nodeVersion: candidate.version }
}

interface Deployed {
  connectCommand: string
  ensure: EnsureResult
  /** 远端 POSIX 时为 true：daemon 监听 unix socket，可走 streamlocal 转发 */
  posix: boolean
  serverCommand(args: readonly string[]): string
}

/** 两类远端只有命令与 SFTP 路径写法不同，部署流程共用。 */
interface RemoteCommandSet {
  mkdir(dir: string): string
  sha(file: string): string
  install(tmp: string, dest: string): string
  ensure(script: string): string
  connect(script: string): string
  server(script: string, args: readonly string[]): string
  sftpPath(path: string): string
}

function commandsFor(probe: RemoteProbe): RemoteCommandSet {
  if (probe.os === 'Windows') {
    return {
      mkdir: buildWindowsMkdirCommand,
      sha: buildWindowsShaCommand,
      install: buildWindowsUploadCommand,
      ensure: buildWindowsEnsureCommand,
      connect: buildWindowsConnectCommand,
      server: buildWindowsServerCommand,
      sftpPath: windowsSftpPath,
    }
  }
  return {
    mkdir: buildMkdirCommand,
    sha: (file) => buildShaCommand(probe.sha256sumPath, file),
    install: buildUploadCommand,
    ensure: (script) => buildEnsureCommand(probe.nodePath, script),
    connect: (script) => buildConnectCommand(probe.nodePath, script),
    server: (script, args) => buildServerCommand(probe.nodePath, script, args),
    sftpPath: (path) => path,
  }
}

async function probeRemote(client: Client): Promise<RemoteProbe> {
  // 不用 execChecked：Windows 的 cmd / PowerShell 跑 POSIX 探测会以非零码退出。
  const posix = await execCommand(client, buildProbeCommand())
  if (isPosixProbe(posix.stdout)) return parseProbe(posix.stdout)
  const windows = await execCommand(client, buildWindowsProbeCommand())
  if (windows.code !== 0) {
    throw new Error(NODE_REQUIRED_DEPLOY)
  }
  return parseWindowsProbe(windows.stdout)
}

type DeployState = (detail: string) => void

async function deployServer(client: Client, onState: DeployState, bundle: ServerBundle, resourcesPath: string): Promise<Deployed> {
  onState('检测远端环境')
  const probe = await probeRemote(client)
  // 内置运行时必须在 commandsFor 之前确定：ensure/connect/server 都要用新 node。
  if (probe.os !== 'Windows' && probe.nodePath === '') {
    const runtime = await installRuntimeNode(client, onState, probe, resourcesPath)
    probe.nodePath = runtime.nodePath
    probe.nodeVersion = runtime.nodeVersion
  }
  const commands = commandsFor(probe)

  const script = serverInstallPath(probe.home, bundle.version, bundle.sha256)
  const dir = parentPosixPath(script)
  await execChecked(client, commands.mkdir(dir))
  const shaCommand = commands.sha(script)

  let remoteSha = parseRemoteSha((await execChecked(client, shaCommand)).stdout)
  if (remoteSha !== bundle.sha256) {
    onState(`上传 server（${formatSize(bundle.bytes.byteLength)}）`)
    const tmp = `${dir}/.qn-server.cjs.tmp-${process.pid}-${Date.now()}`
    await sftpUpload(client, bundle.path, commands.sftpPath(tmp))
    await execChecked(client, commands.install(tmp, script))
    remoteSha = parseRemoteSha((await execChecked(client, shaCommand)).stdout)
    if (remoteSha !== bundle.sha256) throw new Error('远端 server 校验失败，已拒绝启动')
  }

  onState('启动 daemon')
  const ensured = await execChecked(client, commands.ensure(script), ENSURE_TIMEOUT_MS)
  return {
    connectCommand: commands.connect(script),
    ensure: parseEnsureResult(ensured.stdout),
    posix: probe.os !== 'Windows',
    serverCommand: (args) => commands.server(script, args),
  }
}

/**
 * 优先用 OpenSSH streamlocal 转发直连远端 daemon 的 unix socket（参考 Orca：先转发、被拒再走 exec bridge），
 * 省掉每条连接一个 `connect --stdio` Node 进程；sshd 禁用转发（AllowStreamLocalForwarding no）时回退 exec。
 */
function openStreamLocal(client: Client, socketPath: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.openssh_forwardOutStreamLocal(socketPath, (err, channel) => {
      if (err) reject(err)
      else resolve(channel)
    })
  })
}

async function openServerChannel(client: Client, deployed: Deployed): Promise<{ channel: ClientChannel; via: 'streamlocal' | 'exec' }> {
  if (deployed.posix && deployed.ensure.endpoint.startsWith('/')) {
    try {
      return { channel: await openStreamLocal(client, deployed.ensure.endpoint), via: 'streamlocal' }
    } catch {
      // 转发被拒不是错误，回退 exec bridge。
    }
  }
  return { channel: await openConnectChannel(client, deployed.connectCommand), via: 'exec' }
}

/**
 * 经 SSH 部署并执行若干 server 子命令（如 direct enable / grant），返回每条命令输出的 JSON。
 * 输出可能含连接码/token：只返回给调用方，不写日志，失败信息只引用 stderr。
 */
export async function runRemoteServerCommands(
  context: SshRemoteContext,
  commands: ReadonlyArray<readonly string[]>
): Promise<Array<Record<string, unknown>>> {
  const { client, stopVerifying } = await dialTarget(context)
  client.on('error', () => undefined)
  try {
    const bundle = await readServerBundle(context.resourcesPath)
    const deployed = await deployServer(client, (detail) => context.onState?.(detail), bundle, context.resourcesPath)
    const results: Array<Record<string, unknown>> = []
    for (const args of commands) {
      const result = await execChecked(client, deployed.serverCommand(args), ENSURE_TIMEOUT_MS)
      results.push(parseJsonLine(result.stdout))
    }
    return results
  } finally {
    stopVerifying()
    try {
      client.end()
    } catch {
      // 连接可能已经断开。
    }
  }
}

function openConnectChannel(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) reject(new Error(`启动 connect --stdio 失败：${redactToken(err.message)}`))
      else resolve(channel)
    })
  })
}

/** 建立到目标机的 SSH 连接（认证 + 主机指纹确认），连接测试与正式连接共用。 */
async function dialTarget(context: SshTestContext): Promise<{ client: Client; stopVerifying: () => void }> {
  const { target, gate } = context
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
  return { client, stopVerifying: () => { verifyingClient = false } }
}

/** 只验证认证与远端环境，不部署、不启动任何远端进程。 */
export async function testSshTarget(context: SshTestContext): Promise<TargetProbe> {
  const { client, stopVerifying } = await dialTarget(context)
  try {
    const probe = await probeRemote(client)
    // SshTestContext 不带 resourcesPath，内置运行时清单位置退回进程环境注入的配置。
    if (probe.os !== 'Windows' && probe.nodePath === '') {
      const candidate = await findRuntimeCandidate(backendConfig.resourcesPath, probe.os, probe.arch)
      if (!candidate) throw new Error(NODE_REQUIRED_TEST)
      return { os: probe.os, nodeVersion: `内置 ${candidate.version}（连接时推送）` }
    }
    return { os: probe.os, nodeVersion: probe.nodeVersion }
  } finally {
    stopVerifying()
    client.end()
  }
}

export async function connectSshTarget(context: SshLinkContext): Promise<TargetLink> {
  const { target, hooks } = context
  hooks.onState('connecting', `连接 ${target.host}:${target.port}`)
  const { client, stopVerifying } = await dialTarget(context)
  let closed = false
  let userClosed = false
  let channelStderr = ''
  // 握手前就要有 error 监听：部署期间 SSH 断开时不能让未处理的 error 事件打挂 backend。
  const finish = (err?: Error): void => {
    if (closed) return
    closed = true
    stopVerifying()
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
    const deployed = await deployServer(client, (detail) => hooks.onState('deploying', detail), bundle, context.resourcesPath)
    const { channel, via } = await openServerChannel(client, deployed)
    hooks.onState('connecting', via === 'streamlocal' ? 'SSH 转发连接 daemon' : 'SSH 通道连接 daemon')
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
      ...(deployed.ensure.stale ? { notice: STALE_SERVER_NOTICE } : {}),
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
    stopVerifying()
    closed = true
    try {
      client.end()
    } catch {
      // 连接可能已经断开。
    }
    throw err
  }
}
