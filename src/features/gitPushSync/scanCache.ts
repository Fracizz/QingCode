import type { Project } from '@/types'

export type Inspection = { repo: string | null; branch: string | null }

/**
 * 缓存上次识别结果：打开设置页时直接按上次分组显示，后台重扫完成后再整体替换，
 * 避免每次打开都要等全部项目读完。同时存入 localStorage，重启应用后第一次打开也不用等。
 */
const STORAGE_KEY = 'qingcode.gitPushSync.scanCache'
const scanCache = new Map<string, Inspection>()
let loaded = false

export const scanCacheKey = (project: Project) => `${project.id}\u0000${project.path}`

function isInspection(value: unknown): value is Inspection {
  if (!value || typeof value !== 'object') return false
  const { repo, branch } = value as Record<string, unknown>
  const field = (item: unknown) => item === null || typeof item === 'string'
  return field(repo) && field(branch)
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isInspection(value)) scanCache.set(key, value)
    }
  } catch {
    // 存储不可用或内容损坏时只用内存缓存。
  }
}

export function readScanCache(projects: Project[]): Record<string, Inspection> {
  ensureLoaded()
  const entries: Record<string, Inspection> = {}
  for (const project of projects) {
    const cached = scanCache.get(scanCacheKey(project))
    if (cached) entries[project.id] = cached
  }
  return entries
}

/** 写入本次扫描的项目；不在列表里的旧项目一并清掉，存储不会无限增长。 */
export function writeScanCache(projects: Project[], entries: Record<string, Inspection>) {
  ensureLoaded()
  const keep = new Set(projects.map(scanCacheKey))
  for (const key of [...scanCache.keys()]) if (!keep.has(key)) scanCache.delete(key)
  for (const project of projects) {
    const entry = entries[project.id]
    if (entry) scanCache.set(scanCacheKey(project), entry)
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(scanCache)))
  } catch {
    // 忽略：下次启动重新识别即可。
  }
}

/** 清空缓存（测试用）。 */
export function resetScanCache() {
  scanCache.clear()
  loaded = true
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略
  }
}
