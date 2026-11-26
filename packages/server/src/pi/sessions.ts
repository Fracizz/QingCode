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
    .replace(/^[/\\]+/, '')
    .replace(/[\\/:]/g, '-')
    .replace(/^-+|-+$/g, '')
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
  readDir: (dir) => fs.readdirSync(dir),
  stat: (file) => fs.statSync(file),
  readHead: (file, bytes) => {
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
  cwd: string,
  io: SessionIo = defaultIo,
  root: string = sessionRoot(),
): PiSessionInfo[] {
  const dirs = [root, path.join(root, encodeCwdDir(cwd))]
  const seen = new Set<string>()
  const out: PiSessionInfo[] = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = io.readDir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const file = path.join(dir, entry)
      if (seen.has(file)) continue
      seen.add(file)
      let head: string
      try {
        head = io.readHead(file, HEAD_BYTES)
      } catch {
        continue
      }
      const parsed = parseSessionLines(head.split('\n'))
      if (!parsed) continue
      // 自定义 session-dir 会把文件平铺，按 header 的 cwd 过滤保证只列当前项目。
      if (parsed.cwd && !sameCwd(parsed.cwd, cwd)) continue
      let updatedAt: number | undefined
      try {
        updatedAt = Math.floor(io.stat(file).mtimeMs / 1000)
      } catch {
        updatedAt = undefined
      }
      const meta: SessionMeta = {
        id: parsed.id,
        cwd: parsed.cwd || cwd,
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
