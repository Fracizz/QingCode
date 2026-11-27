import { create } from 'zustand'
import type { Project } from '../../../shared/backendApi'

// 单独成模块：codex、run 两个 store 都要查信任状态，直接依赖 projects store 会形成循环引用。
type ProjectTrustState = {
  /** 各目标上未信任项目的路径（已去掉尾部斜杠）。 */
  untrustedByTarget: Record<string, string[]>
  setTargetProjects: (targetId: string, projects: readonly Project[]) => void
}

const trimPath = (path: string) => path.trim().replace(/[\\/]+$/, '') || path.trim()

/** cwd 等于未信任项目根或位于其子目录时都算未信任；Windows 路径不区分大小写和分隔符。 */
export function isPathUntrusted(untrusted: readonly string[], cwd: string | null | undefined): boolean {
  if (!cwd) return false
  const windows = /^[A-Za-z]:/.test(cwd)
  const norm = (path: string) => {
    const value = trimPath(path)
    return windows ? value.replace(/\//g, '\\').toLowerCase() : value
  }
  const current = norm(cwd)
  const sep = windows ? '\\' : '/'
  return untrusted.some((root) => {
    const base = norm(root)
    return current === base || current.startsWith(base.endsWith(sep) ? base : base + sep)
  })
}

export const useProjectTrust = create<ProjectTrustState>((set) => ({
  untrustedByTarget: {},
  setTargetProjects: (targetId, projects) => set((state) => {
    const untrusted = projects.filter((project) => !project.trusted).map((project) => trimPath(project.path))
    const previous = state.untrustedByTarget[targetId] ?? []
    if (previous.length === untrusted.length && previous.every((path, index) => path === untrusted[index])) return {}
    return { untrustedByTarget: { ...state.untrustedByTarget, [targetId]: untrusted } }
  }),
}))

const EMPTY: string[] = []

export function isCwdUntrusted(targetId: string | null | undefined, cwd: string | null | undefined): boolean {
  if (!targetId) return false
  return isPathUntrusted(useProjectTrust.getState().untrustedByTarget[targetId] ?? EMPTY, cwd)
}

/** React 订阅版：未信任状态变化时重新渲染。 */
export function useCwdUntrusted(targetId: string | null | undefined, cwd: string | null | undefined): boolean {
  return useProjectTrust((state) => Boolean(targetId) && isPathUntrusted(state.untrustedByTarget[targetId!] ?? EMPTY, cwd))
}
