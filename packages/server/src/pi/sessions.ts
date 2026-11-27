/**
 * 会话列表：按官方公开的 session-format.md 只读解析 pi 的 .jsonl 会话文件头部。
 * 只读会话内容；不读 auth.json / models.json / 任何凭据或配置文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asRecord, scalarText, type Json, type SessionMeta } from '../claude/v2'

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
    if (record.type === 'session_info' && !name) name = scalarText(record.name)
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
      const meta: SessionMeta = {
        id: parsed.id,
        cwd: sessionCwd,
        preview: parsed.preview ?? '',
        ...(parsed.name ? { name: parsed.name } : {}),
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
