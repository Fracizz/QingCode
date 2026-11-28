/**
 * 会话列表：按官方公开的 session-format.md 只读解析 pi 的 .jsonl 会话文件头部。
 * 只读会话内容；不读 auth.json / models.json / 任何凭据或配置文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asRecord, scalarText, type Json, type SessionMeta } from '../claude/v2'
import { piUserText } from './userText'

export interface PiSessionInfo {
  meta: SessionMeta
  sessionFile: string
}

export interface ParsedSessionHeader {
  id: string
  cwd: string
  createdAt?: number
  preview?: string
  name?: string
}

export interface SessionIo {
  readDir(dir: string): string[]
  stat(file: string): { mtimeMs: number }
  readHead(file: string, bytes: number): string
  /** 头部之后的末尾一块，用来取最近一次改名；省略时只看头部。 */
  readTail?(file: string, bytes: number): string
}

const HEAD_BYTES = 64 * 1024
const MAX_SESSIONS = 2000

/** pi 的会话目录名：去掉前导分隔符，把 / \\ : 换成 -，再包一层 --。 */
export function encodeCwdDir(cwd: string): string {
  const flat = cwd
    .replace(/^[/\\]/, '')
    .replace(/[\\/:]/g, '-')
  return `--${flat}--`
}

export function sessionRoot(): string {
  const override = process.env.PI_CODING_AGENT_SESSION_DIR
  return override && override.trim()
    ? override.trim()
    : path.join(os.homedir(), '.pi', 'agent', 'sessions')
}

export function sameCwd(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export function parseSessionLines(lines: string[]): ParsedSessionHeader | null {
  let header: Json | null = null
  let preview = ''
  let name = ''
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      // 截断的最后一行不是完整 JSON，忽略即可。
      continue
    }
    const record = asRecord(entry)
    if (!record) continue
    if (record.type === 'session' && !header) {
      header = record
      continue
    }
    // 改名按追加记录保存，后写的覆盖先写的，空名称表示清除。
    if (record.type === 'session_info') name = scalarText(record.name).trim()
    if (record.type === 'message' && !preview) {
      const message = asRecord(record.message)
      if (scalarText(message?.role) !== 'user') continue
      const content = message?.content
      if (typeof content === 'string') preview = content
      else if (Array.isArray(content)) {
        preview = content
          .map((block) => {
            const item = asRecord(block)
            return item?.type === 'text' ? scalarText(item.text) : ''
          })
          .filter(Boolean)
          .join(' ')
      }
      // 只带附件时用文件名当标题。
      const shown = piUserText(preview)
      preview = shown.text || shown.files.map((file) => file.split(/[\\/]/).pop()).join(' ')
    }
  }
  if (!header) return null
  const id = scalarText(header.id)
  if (!id) return null
  const cwd = scalarText(header.cwd)
  const timestamp = Date.parse(scalarText(header.timestamp))
  return {
    id,
    cwd,
    ...(Number.isFinite(timestamp) ? { createdAt: Math.floor(timestamp / 1000) } : {}),
    ...(preview ? { preview: preview.slice(0, 200) } : {}),
    ...(name ? { name } : {}),
  }
}

const defaultIo: SessionIo = {
  readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => entry.name),
  stat: (file) => fs.statSync(file),
  readHead: (file, bytes) => {
    if (!fs.lstatSync(file).isFile()) return ''
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const read = fs.readSync(fd, buffer, 0, bytes, 0)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  },
  readTail: (file, bytes) => {
    if (!fs.lstatSync(file).isFile()) return ''
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(HEAD_BYTES, size - bytes)
      if (size <= start) return ''
      const buffer = Buffer.alloc(size - start)
      const read = fs.readSync(fd, buffer, 0, buffer.length, start)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  },
}

/** 末尾一块里最后一次改名；没有改名记录时返回 null。 */
function tailName(io: SessionIo, file: string): string | null {
  let tail: string
  try {
    tail = io.readTail?.(file, HEAD_BYTES) ?? ''
  } catch {
    return null
  }
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.includes('"session_info"')) continue
    try {
      const record = asRecord(JSON.parse(line))
      if (record?.type === 'session_info') return scalarText(record.name).trim()
    } catch {
      // 分块切开的半行不是完整 JSON，继续向前找。
    }
  }
  return null
}

export function listPiSessions(
  cwd?: string | string[],
  io: SessionIo = defaultIo,
  root: string = sessionRoot(),
  threadId?: string,
): PiSessionInfo[] {
  const cwds = cwd === undefined ? undefined : Array.isArray(cwd) ? cwd : [cwd]
  if (cwds?.length === 0) return []
  const rootEntries = readEntries(io, root)
  const groupKey = (dir: string) => process.platform === 'win32' ? dir.toLowerCase() : dir
  const groups = cwds && new Set(cwds.map((dir) => groupKey(encodeCwdDir(path.resolve(dir)))))
  const dirs = new Map([[root, rootEntries]])
  for (const group of rootEntries) {
    if (!group.startsWith('--') || !group.endsWith('--') || (groups && !groups.has(groupKey(group)))) continue
    const dir = path.join(root, group)
    dirs.set(dir, readEntries(io, dir))
  }
  const out: PiSessionInfo[] = []
  for (const [dir, entries] of dirs) {
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const file = path.join(dir, entry)
      let head: string
      try {
        head = io.readHead(file, HEAD_BYTES)
      } catch {
        continue
      }
      const parsed = parseSessionLines(head.split('\n'))
      if (!parsed || (threadId && parsed.id !== threadId)) continue
      // 自定义 session-dir 会把文件平铺，按 header 的 cwd 过滤保证只列当前项目。
      if (cwds && !cwds.some((dir) => parsed.cwd ? sameCwd(parsed.cwd, dir) : cwds.length === 1)) continue
      const sessionCwd = parsed.cwd || cwds?.[0]
      if (!sessionCwd) continue
      let updatedAt: number | undefined
      try {
        updatedAt = Math.floor(io.stat(file).mtimeMs / 1000)
      } catch {
        updatedAt = undefined
      }
      const name = tailName(io, file) ?? parsed.name
      const meta: SessionMeta = {
        id: parsed.id,
        cwd: sessionCwd,
        preview: parsed.preview ?? '',
        ...(name ? { name } : {}),
        ...(parsed.createdAt !== undefined ? { createdAt: parsed.createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      }
      out.push({ meta, sessionFile: file })
    }
  }
  return out.sort((a, b) => (b.meta.updatedAt ?? 0) - (a.meta.updatedAt ?? 0)).slice(0, MAX_SESSIONS)
}

function readEntries(io: SessionIo, dir: string): string[] {
  try {
    return io.readDir(dir)
  } catch {
    return []
  }
}

/** 会话最近一次使用的模型（provider/id，与 model/list 的 id 同格式）与思考档位。 */
export interface PiSessionConfig {
  model: string | null
  thinkingLevel: string | null
}

/**
 * 按 session-format.md 的条目顺序取最后一次的模型与思考档位：
 * model_change / thinking_level_change 是显式切换，assistant 消息上的 provider/model/thinkingLevel 是实际使用值。
 * 会话是树形结构，这里按文件顺序取最后写入的值，对线性会话即当前分支。
 */
export function parseSessionConfig(lines: string[]): PiSessionConfig {
  let model: string | null = null
  let thinkingLevel: string | null = null
  const setModel = (provider: string, id: string) => {
    if (id) model = provider ? `${provider}/${id}` : id
  }
  for (const line of lines) {
    if (!line.trim()) continue
    let record: Json | null
    try {
      record = asRecord(JSON.parse(line))
    } catch {
      // 首尾分块切开的半行不是完整 JSON，忽略。
      continue
    }
    if (!record) continue
    if (record.type === 'model_change') setModel(scalarText(record.provider), scalarText(record.modelId) || scalarText(record.model))
    else if (record.type === 'thinking_level_change') thinkingLevel = scalarText(record.thinkingLevel) || thinkingLevel
    else if (record.type === 'message') {
      const message = asRecord(record.message)
      if (scalarText(message?.role) !== 'assistant') continue
      setModel(scalarText(message?.provider), scalarText(message?.model))
      thinkingLevel = scalarText(message?.thinkingLevel) || thinkingLevel
    }
  }
  return { model, thinkingLevel }
}

const CONFIG_TAIL_BYTES = 256 * 1024

/**
 * 只读会话文件的头部与尾部各一块：头部有创建时的 model_change，尾部有最近的切换和回复。
 * 中间的切换只在尾部没有更新记录时才会漏掉，换来大会话也只读固定字节数。
 */
export function readPiSessionConfig(file: string): PiSessionConfig {
  const empty: PiSessionConfig = { model: null, thinkingLevel: null }
  let fd: number
  try {
    if (!fs.lstatSync(file).isFile()) return empty
    fd = fs.openSync(file, 'r')
  } catch {
    return empty
  }
  try {
    const size = fs.fstatSync(fd).size
    const read = (start: number, length: number) => {
      const buffer = Buffer.alloc(length)
      const count = fs.readSync(fd, buffer, 0, length, start)
      return buffer.subarray(0, count).toString('utf8')
    }
    const head = read(0, Math.min(size, HEAD_BYTES))
    const tailStart = Math.max(HEAD_BYTES, size - CONFIG_TAIL_BYTES)
    const tail = size > tailStart ? read(tailStart, size - tailStart) : ''
    return parseSessionConfig([...head.split('\n'), ...tail.split('\n')])
  } catch {
    return empty
  } finally {
    fs.closeSync(fd)
  }
}
