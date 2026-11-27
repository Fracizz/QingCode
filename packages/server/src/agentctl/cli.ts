/** `qn`：Agent（以及用户终端）调度 QingCode 能力的命令行。经 daemon 注入的 agent token 连回本机 daemon。 */
import path from 'node:path'
import { IpcClient } from '../client'
import { VERSION } from '../version'
import { QN_ENV } from './env'
import { AGENT_GUIDE } from './guide'

export class QnUsageError extends Error {}

export interface QnArgs {
  command: string
  sub?: string
  positionals: string[]
  flags: Record<string, string | true>
}

const BOOL_FLAGS = new Set(['json', 'help'])
const VALUE_FLAGS = new Set(['title', 'line', 'column', 'since', 'tail'])
const SUBCOMMANDS: Record<string, readonly string[]> = {
  run: ['list', 'output'],
  term: ['list', 'read'],
}
const COMMANDS = ['guide', 'help', 'status', 'notify', 'open', 'run', 'term']

export function parseQnArgs(argv: readonly string[]): QnArgs {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      if (BOOL_FLAGS.has(name)) {
        if (eq > 0) throw new QnUsageError(`--${name} 不接受取值`)
        flags[name] = true
        continue
      }
      if (!VALUE_FLAGS.has(name)) throw new QnUsageError(`未知参数 --${name}`)
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
      if (value === undefined) throw new QnUsageError(`--${name} 需要取值`)
      flags[name] = value
      continue
    }
    if (arg === '-h') {
      flags.help = true
      continue
    }
    positionals.push(arg)
  }
  const command = positionals.shift() ?? 'help'
  if (!COMMANDS.includes(command)) throw new QnUsageError(`未知命令 ${command}，运行 qn guide 查看用法`)
  const subs = SUBCOMMANDS[command]
  if (!subs) return { command, positionals, flags }
  const sub = positionals.shift()
  if (!sub || !subs.includes(sub)) throw new QnUsageError(`qn ${command} 需要子命令: ${subs.join(' | ')}`)
  return { command, sub, positionals, flags }
}

export function intFlag(flags: QnArgs['flags'], name: string, min = 0): number | undefined {
  const raw = flags[name]
  if (raw === undefined) return undefined
  const value = typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isInteger(value) || value < min) throw new QnUsageError(`--${name} 需要不小于 ${min} 的整数`)
  return value
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** 终端/运行输出给 Agent 看：去控制符、处理回车覆盖，只留最后若干行。 */
export function plainTail(text: string, lines: number): string {
  const cleaned = text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => {
      const stripped = line.replace(/\r$/, '')
      const cut = stripped.lastIndexOf('\r')
      return cut >= 0 ? stripped.slice(cut + 1) : stripped
    })
  while (cleaned.length > 0 && cleaned[cleaned.length - 1]?.trim() === '') cleaned.pop()
  return cleaned.slice(-lines).join('\n')
}

type Json = Record<string, unknown>

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.map((entry) => asRecord(entry)).filter((entry): entry is Json => entry !== null) : []
}

export interface QnIo {
  env: NodeJS.ProcessEnv
  cwd: string
  stdout(line: string): void
  stderr(line: string): void
}

export async function runQn(argv: readonly string[], io: QnIo): Promise<number> {
  const args = parseQnArgs(argv)
  if (args.command === 'help' || args.command === 'guide' || args.flags.help) {
    io.stdout(AGENT_GUIDE)
    return 0
  }
  const endpoint = io.env[QN_ENV.endpoint]
  const token = io.env[QN_ENV.token]
  if (!endpoint || !token) {
    io.stderr('qn: 未检测到 QingCode 环境（QN_ENDPOINT / QN_AGENT_TOKEN）。qn 只能在 QingCode 拉起的 Agent 或终端中使用。')
    return 2
  }
  const client = await IpcClient.connectEndpoint(endpoint, token, 3000, 'qn')
  try {
    return await dispatch(args, client, io)
  } finally {
    client.close()
  }
}

function emit(io: QnIo, args: QnArgs, json: unknown, human: string): void {
  io.stdout(args.flags.json ? JSON.stringify(json) : human)
}

async function dispatch(args: QnArgs, client: IpcClient, io: QnIo): Promise<number> {
  switch (args.command) {
    case 'status': {
      const ping = asRecord(await client.request('ping'))
      const info = { serverVersion: ping?.serverVersion ?? client.serverVersion, cliVersion: VERSION, cwd: io.cwd }
      emit(io, args, info, `QingCode server ${String(info.serverVersion)}\ncwd: ${info.cwd}`)
      return 0
    }
    case 'notify': {
      const body = args.positionals.join(' ').trim()
      if (!body) throw new QnUsageError('用法: qn notify "内容" [--title 标题]')
      const title = typeof args.flags.title === 'string' ? args.flags.title : undefined
      const result = asRecord(await client.request('ui.notify', { body, ...(title ? { title } : {}) }))
      const delivered = Number(result?.delivered ?? 0)
      emit(io, args, { delivered }, delivered > 0 ? '已提醒用户' : '没有打开的 QingCode 窗口，提醒未送达')
      return 0
    }
    case 'open': {
      const target = args.positionals[0]
      if (!target) throw new QnUsageError('用法: qn open <路径> [--line N] [--column N]')
      const file = path.resolve(io.cwd, target)
      const line = intFlag(args.flags, 'line', 1)
      const column = intFlag(args.flags, 'column', 1)
      const result = asRecord(await client.request('ui.open', { path: file, ...(line ? { line } : {}), ...(column ? { column } : {}) }))
      const delivered = Number(result?.delivered ?? 0)
      emit(io, args, { path: file, delivered }, delivered > 0 ? `已在 QingCode 中打开 ${file}` : '没有打开的 QingCode 窗口')
      return 0
    }
    case 'run':
      return args.sub === 'list' ? runList(args, client, io) : runOutput(args, client, io)
    case 'term':
      return args.sub === 'list' ? termList(args, client, io) : termRead(args, client, io)
  }
  throw new QnUsageError(`未知命令 ${args.command}`)
}

async function runList(args: QnArgs, client: IpcClient, io: QnIo): Promise<number> {
  const runs = records(asRecord(await client.request('run.list', {}))?.runs)
  const lines = runs.map((run) => {
    const state = run.endedAt === undefined ? '运行中' : `已结束(${String(run.exitCode ?? run.signal ?? '?')})`
    return `${text(run.runId)}  ${state}  ${text(run.label)}  ${text(run.command)}  [${text(run.workdir)}]`
  })
  emit(io, args, runs, lines.length ? lines.join('\n') : '没有运行配置记录')
  return 0
}

async function runOutput(args: QnArgs, client: IpcClient, io: QnIo): Promise<number> {
  const runId = args.positionals[0]
  if (!runId) throw new QnUsageError('用法: qn run output <runId> [--since SEQ] [--tail 行数]')
  const since = intFlag(args.flags, 'since')
  const tail = intFlag(args.flags, 'tail', 1) ?? 200
  const result = asRecord(await client.request('run.output', { runId, ...(since !== undefined ? { sinceSeq: since } : {}) }))
  const body = plainTail(records(result?.chunks).map((chunk) => text(chunk.data)).join(''), tail)
  emit(io, args, { runId, lastSeq: result?.lastSeq, running: result?.running, truncated: result?.truncated, text: body }, [
    body,
    `--- lastSeq=${String(result?.lastSeq ?? '?')} ${result?.running ? '运行中' : '已结束'}${result?.truncated ? '（早期输出已截断）' : ''}`,
  ].join('\n'))
  return 0
}

async function termList(args: QnArgs, client: IpcClient, io: QnIo): Promise<number> {
  const terms = records(asRecord(await client.request('term.list', {}))?.terminals)
  const lines = terms.map((term) => `${text(term.termId)}  ${term.alive ? '运行中' : '已退出'}  ${text(term.shell)}  [${text(term.cwd)}]`)
  emit(io, args, terms, lines.length ? lines.join('\n') : '没有打开的终端')
  return 0
}

async function termRead(args: QnArgs, client: IpcClient, io: QnIo): Promise<number> {
  const termId = args.positionals[0]
  if (!termId) throw new QnUsageError('用法: qn term read <termId> [--tail 行数]')
  const tail = intFlag(args.flags, 'tail', 1) ?? 100
  const result = asRecord(await client.request('term.attach', { termId, sinceSeq: 0 }))
  // 只为取一次输出，立刻退订；连接关闭时 daemon 也会清理。
  await client.request('term.detach', { termId }).catch(() => undefined)
  const snapshot = text(asRecord(result?.snapshot)?.data)
  const body = plainTail(snapshot + records(result?.chunks).map((chunk) => text(chunk.data)).join(''), tail)
  emit(io, args, { termId, alive: result?.alive ?? null, text: body }, body || '(无输出)')
  return 0
}
