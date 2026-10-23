import {
  DEFAULT_GLOBAL_SETTINGS,
  GIT_REFRESH_INTERVAL_START_MINUTES_KEY,
  loadGlobalSettings,
  saveGlobalSettings,
} from './projectSettings'

export const GIT_REFRESH_INTERVAL_START_EVENT = 'qingcode:git-refresh-interval-start-changed'
export const GIT_REFRESH_INTERVAL_START_CACHE_KEY = 'qingcode:git-refresh-interval-start-minutes'

export const DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES = 5
export const MIN_GIT_REFRESH_INTERVAL_START_MINUTES = 5
export const MAX_GIT_REFRESH_INTERVAL_START_MINUTES = 24 * 60

/** 状态栏分支芯片的本地轮询周期。 */
export const GIT_HEAD_REFRESH_MS = 15_000

/**
 * 状态栏取分支的轮询周期；SSH 项目返回 0（不轮询）。
 *
 * SSH 没有单独的 `git_head` 命令，取分支就是一次完整 `git status`：
 * 15 秒一次等于每小时 240 次远程往返，只为显示一个很少变化的分支名。
 * SSH 的分支名改为跟随 SCM / workdir 快照更新。
 */
export function gitHeadPollIntervalMs(isSshProject: boolean): number {
  return isSshProject ? 0 : GIT_HEAD_REFRESH_MS
}

export function parseGitRefreshIntervalStartMinutes(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES
  return Math.min(
    MAX_GIT_REFRESH_INTERVAL_START_MINUTES,
    Math.max(MIN_GIT_REFRESH_INTERVAL_START_MINUTES, Math.round(parsed))
  )
}

let cachedIntervalStartMinutes = parseGitRefreshIntervalStartMinutes(
  DEFAULT_GLOBAL_SETTINGS[GIT_REFRESH_INTERVAL_START_MINUTES_KEY]
)

function writeCache(intervalStartMinutes: number) {
  try {
    localStorage.setItem(GIT_REFRESH_INTERVAL_START_CACHE_KEY, String(intervalStartMinutes))
  } catch {
    /* private mode */
  }
}

export function getGitRefreshIntervalStartMinutes(): number {
  try {
    const raw = localStorage.getItem(GIT_REFRESH_INTERVAL_START_CACHE_KEY)
    if (raw !== null) return parseGitRefreshIntervalStartMinutes(raw)
  } catch {
    /* ignore */
  }
  return cachedIntervalStartMinutes
}

export function readGitRefreshIntervalStartMinutes(settings: Record<string, unknown>): number {
  return parseGitRefreshIntervalStartMinutes(settings[GIT_REFRESH_INTERVAL_START_MINUTES_KEY])
}

function applyGitRefreshIntervalStartMinutes(intervalStartMinutes: number, notify: boolean) {
  cachedIntervalStartMinutes = intervalStartMinutes
  writeCache(intervalStartMinutes)
  if (notify && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(GIT_REFRESH_INTERVAL_START_EVENT, {
        detail: { intervalStartMinutes },
      })
    )
  }
}

export async function loadGitRefreshIntervalStartMinutes(): Promise<number> {
  try {
    const intervalStartMinutes = readGitRefreshIntervalStartMinutes(await loadGlobalSettings())
    applyGitRefreshIntervalStartMinutes(intervalStartMinutes, true)
    return intervalStartMinutes
  } catch {
    return getGitRefreshIntervalStartMinutes()
  }
}

export async function saveGitRefreshIntervalStartMinutes(value: unknown): Promise<number> {
  const intervalStartMinutes = parseGitRefreshIntervalStartMinutes(value)
  const settings = await loadGlobalSettings()
  settings[GIT_REFRESH_INTERVAL_START_MINUTES_KEY] = intervalStartMinutes
  await saveGlobalSettings(settings)
  applyGitRefreshIntervalStartMinutes(intervalStartMinutes, true)
  return intervalStartMinutes
}

export function defaultGitRefreshIntervalStartMinutes(): number {
  return parseGitRefreshIntervalStartMinutes(
    DEFAULT_GLOBAL_SETTINGS[GIT_REFRESH_INTERVAL_START_MINUTES_KEY]
  )
}
