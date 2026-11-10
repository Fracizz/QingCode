import type { Project } from '@/types'

export type Inspection = { repo: string | null; branch: string | null }

/**
 * 跨挂载缓存上次识别结果：重新打开设置页时直接按上次分组显示，
 * 后台重扫完成后再整体替换，避免每次打开都从“未连接”逐个跳到各仓库。
 */
const scanCache = new Map<string, Inspection>()

export const scanCacheKey = (project: Project) => `${project.id}\u0000${project.path}`

export function readScanCache(projects: Project[]): Record<string, Inspection> {
  const entries: Record<string, Inspection> = {}
  for (const project of projects) {
    const cached = scanCache.get(scanCacheKey(project))
    if (cached) entries[project.id] = cached
  }
  return entries
}

export function writeScanCache(projects: Project[], entries: Record<string, Inspection>) {
  for (const project of projects) {
    const entry = entries[project.id]
    if (entry) scanCache.set(scanCacheKey(project), entry)
  }
}

/** 清空缓存（测试用）。 */
export function resetScanCache() {
  scanCache.clear()
}
