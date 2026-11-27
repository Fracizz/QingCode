/**
 * skills/list：扫描 Claude Code 的 skills 与斜杠命令，映射成 codex v2 的 SkillMetadata。
 * 纯逻辑（frontmatter、命令名、去重排序）与目录扫描分开，扫描用注入的 home 便于测试。
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, relative, sep } from 'node:path'
import type { Json } from './v2'

export interface SkillEntry {
  name: string
  description: string
  path: string
  scope: 'user' | 'repo'
}

export interface SkillError {
  path: string
  message: string
}

const MAX_DESCRIPTION = 200

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 只支持 skill 文件实际用到的简单 YAML：key: value、引号、以及 > / | 块标量与缩进续行。 */
export function parseFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const text = source.replace(/^﻿/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = (match[1] ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1] as string
    const raw = (kv[2] ?? '').trim()
    const continuation: string[] = []
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) {
      continuation.push((lines[++i] ?? '').trim())
    }
    if (/^[>|][+-]?$/.test(raw)) {
      meta[key] = continuation.join(raw.startsWith('|') ? '\n' : ' ').trim()
    } else {
      meta[key] = [stripQuotes(raw), ...continuation].filter(Boolean).join(' ')
    }
  }
  return { meta, body: text.slice(match[0].length) }
}

export function truncateDescription(text: string): string {
  const flat = text.trim()
  return flat.length > MAX_DESCRIPTION ? flat.slice(0, MAX_DESCRIPTION) : flat
}

/** description 缺省时取正文首个非空行，并去掉 Markdown 标题前缀。 */
export function firstBodyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^#+\s*/, '')
    if (cleaned) return cleaned
  }
  return ''
}

/** commands 下的相对路径 → 命令名：去扩展名，子目录用冒号连接。 */
export function commandNameFromRelativePath(rel: string): string {
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  const last = parts.pop() ?? ''
  const stem = last.slice(0, last.length - extname(last).length)
  return [...parts, stem].join(':')
}

export function entryFromFile(
  source: string,
  fallbackName: string,
  path: string,
  scope: 'user' | 'repo',
): SkillEntry {
  const { meta, body } = parseFrontmatter(source)
  return {
    name: meta.name?.trim() || fallbackName,
    description: truncateDescription(meta.description || firstBodyLine(body)),
    path,
    scope,
  }
}

/** 按 name 去重（先出现者优先，调用方把项目级放前面），再按 name 排序。 */
export function dedupeAndSort(entries: SkillEntry[]): SkillEntry[] {
  const seen = new Set<string>()
  const out: SkillEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry)
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function skillMetadata(entry: SkillEntry): Json {
  return {
    name: entry.name,
    description: entry.description,
    path: entry.path,
    scope: entry.scope,
    enabled: true,
    pluginId: null,
  }
}

async function readDirents(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    // 目录不存在是常态（用户没建过 skills/commands），不算错误。
    return []
  }
}

async function scanSkillDirs(
  root: string,
  scope: 'user' | 'repo',
  entries: SkillEntry[],
  errors: SkillError[],
): Promise<void> {
  for (const dirent of await readDirents(root)) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    const path = join(root, dirent.name, 'SKILL.md')
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        errors.push({ path, message: err instanceof Error ? err.message : String(err) })
      }
      continue
    }
    try {
      entries.push(entryFromFile(source, dirent.name, path, scope))
    } catch (err) {
      errors.push({ path, message: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function scanCommandDir(
  root: string,
  dir: string,
  scope: 'user' | 'repo',
  entries: SkillEntry[],
  errors: SkillError[],
): Promise<void> {
  for (const dirent of await readDirents(dir)) {
    const path = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      await scanCommandDir(root, path, scope, entries, errors)
      continue
    }
    if (!dirent.isFile() || extname(dirent.name).toLowerCase() !== '.md') continue
    try {
      const rel = relative(root, path).split(sep).join('/')
      const source = await readFile(path, 'utf8')
      entries.push(entryFromFile(source, commandNameFromRelativePath(rel), path, scope))
    } catch (err) {
      errors.push({ path, message: err instanceof Error ? err.message : String(err) })
    }
  }
}

export interface ScanResult {
  skills: SkillEntry[]
  errors: SkillError[]
}

/** 项目级优先于用户级；同级 skill 优先于同名命令。 */
export async function scanSkills(cwd: string, home: string = homedir()): Promise<ScanResult> {
  const entries: SkillEntry[] = []
  const errors: SkillError[] = []
  await scanSkillDirs(join(cwd, '.claude', 'skills'), 'repo', entries, errors)
  const projectCommands = join(cwd, '.claude', 'commands')
  await scanCommandDir(projectCommands, projectCommands, 'repo', entries, errors)
  await scanSkillDirs(join(home, '.claude', 'skills'), 'user', entries, errors)
  const userCommands = join(home, '.claude', 'commands')
  await scanCommandDir(userCommands, userCommands, 'user', entries, errors)
  return { skills: dedupeAndSort(entries), errors }
}

/** 按 cwd 缓存扫描结果；forceReload 时重扫。 */
export class SkillsCatalog {
  private readonly cache = new Map<string, ScanResult>()

  constructor(private readonly home: string = homedir()) {}

  async list(cwds: string[], forceReload = false): Promise<Json> {
    const data: Json[] = []
    for (const cwd of cwds) {
      let result = forceReload ? undefined : this.cache.get(cwd)
      if (!result) {
        result = await scanSkills(cwd, this.home)
        this.cache.set(cwd, result)
      }
      data.push({
        cwd,
        skills: result.skills.map(skillMetadata),
        errors: result.errors.map((e) => ({ path: e.path, message: e.message })),
      })
    }
    return { data }
  }
}
