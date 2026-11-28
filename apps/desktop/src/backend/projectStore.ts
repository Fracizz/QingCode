import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project } from '../shared/backendApi'

const PROJECTS_FILE = 'projects.json'

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export type ProjectInput = {
  id?: string
  targetId: string
  name?: string
  path: string
  lastOpenedAt?: number
  trusted?: boolean
  hidden?: boolean
}

// 远端是 POSIX 路径、本机是 Windows 路径，不能用 node:path 单侧解析。
export function basenameOf(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || path.trim()
}

// 去掉尾部斜杠，避免同一目录被存成两条；根目录本身保留。
export function normalizeProjectPath(path: string): string {
  const trimmed = path.trim()
  return trimmed.replace(/[\\/]+$/, '') || trimmed
}

export function projectKey(targetId: string, path: string): string {
  return `${targetId}\u0000${normalizeProjectPath(path)}`
}

function parseProject(x: unknown): Project | null {
  if (!isRecord(x)) return null
  const id = typeof x.id === 'string' && x.id !== '' ? x.id : null
  const targetId = typeof x.targetId === 'string' && x.targetId !== '' ? x.targetId : null
  const rawPath = typeof x.path === 'string' ? normalizeProjectPath(x.path) : ''
  if (!id || !targetId || rawPath === '') return null
  const name = typeof x.name === 'string' && x.name.trim() !== '' ? x.name.trim() : basenameOf(rawPath)
  const time = typeof x.lastOpenedAt === 'number' && Number.isFinite(x.lastOpenedAt)
    ? Math.max(0, Math.round(x.lastOpenedAt))
    : 0
  // 信任功能上线前保存的项目都由用户主动添加，迁移时视为已信任。
  const trusted = x.trusted !== false
  // 只在隐藏时落盘该字段，旧文件与未隐藏项目保持原样。
  return x.hidden === true
    ? { id, targetId, name, path: rawPath, lastOpenedAt: time, trusted, hidden: true }
    : { id, targetId, name, path: rawPath, lastOpenedAt: time, trusted }
}

export function sortProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt || a.id.localeCompare(b.id)
  )
}

export function normalizeProjects(raw: unknown): Project[] {
  const items = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const result: Project[] = []
  for (const item of items) {
    const project = parseProject(item)
    if (!project) continue
    const key = projectKey(project.targetId, project.path)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(project)
  }
  return sortProjects(result)
}

export function listProjects(projects: readonly Project[], targetId?: string): Project[] {
  return sortProjects(
    targetId ? projects.filter((p) => p.targetId === targetId) : projects
  )
}

export function upsertProject(
  projects: readonly Project[],
  input: ProjectInput,
  newId: string,
  now: number = Date.now()
): { projects: Project[]; project: Project } {
  const path = normalizeProjectPath(typeof input.path === 'string' ? input.path : '')
  const targetId = typeof input.targetId === 'string' ? input.targetId.trim() : ''
  if (path === '' || targetId === '') {
    throw new Error('项目路径与目标不能为空')
  }
  const key = projectKey(targetId, path)
  const at = projects.findIndex((p) => projectKey(p.targetId, p.path) === key)
  const existing = at >= 0 ? projects[at] : undefined
  const id = input.id && input.id !== '' ? input.id : existing?.id ?? newId
  const name = input.name?.trim() || existing?.name || basenameOf(path)
  const lastOpenedAt = typeof input.lastOpenedAt === 'number' && Number.isFinite(input.lastOpenedAt)
    ? Math.max(0, Math.round(input.lastOpenedAt))
    : now
  // 新项目未显式信任时默认不信任；已有项目未传值时保留原状态。
  const trusted = typeof input.trusted === 'boolean' ? input.trusted : existing?.trusted ?? false
  // 打开项目等保存不传 hidden，沿用原状态，避免把隐藏项目意外恢复。
  const hidden = typeof input.hidden === 'boolean' ? input.hidden : existing?.hidden === true
  const next: Project = hidden
    ? { id, targetId, name, path, lastOpenedAt, trusted, hidden: true }
    : { id, targetId, name, path, lastOpenedAt, trusted }
  const list = [...projects]
  if (at >= 0) list[at] = next
  else list.push(next)
  const normalized = normalizeProjects(list)
  return { projects: normalized, project: normalized.find((p) => p.id === id) ?? next }
}

export function removeProject(projects: readonly Project[], id: string): Project[] {
  return normalizeProjects(projects.filter((p) => p.id !== id))
}

export function serializeProjects(projects: readonly Project[]): string {
  return JSON.stringify(normalizeProjects(projects), null, 2) + '\n'
}

export function createProjectId(): string {
  return `project-${randomUUID()}`
}

export async function readProjects(userData: string): Promise<Project[]> {
  try {
    const text = await readFile(join(userData, PROJECTS_FILE), 'utf8')
    return normalizeProjects(JSON.parse(text) as unknown)
  } catch {
    // 文件缺失或损坏时不应让整个 backend 启动失败。
    return []
  }
}

export async function writeProjects(userData: string, projects: readonly Project[]): Promise<void> {
  const file = join(userData, PROJECTS_FILE)
  const tmp = `${file}.tmp`
  await mkdir(userData, { recursive: true })
  await writeFile(tmp, serializeProjects(projects), 'utf8')
  await rename(tmp, file)
}
