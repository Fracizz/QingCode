import type { Project } from '../types'
import { confirmDialog } from '../store/confirmStore'
import { translate } from './i18n'
import { syncRootsFromProjects, syncTrustedRoots } from './pathAllowlist'

/** New storage; migrates once from legacy `qingcode:run-trust`. */
export const WORKSPACE_TRUST_STORAGE_KEY = 'qingcode:workspace-trust'
export const WORKSPACE_TRUST_CHANGED_EVENT = 'qingcode:workspace-trust-changed'

/** @deprecated Kept so older builds' keys can be migrated. */
export const RUN_TRUST_STORAGE_KEY = 'qingcode:run-trust'
export const RUN_TRUST_CHANGED_EVENT = WORKSPACE_TRUST_CHANGED_EVENT

export type WorkspaceTrustLevel = 'trusted' | 'restricted'

type TrustStore = {
  trustedIds: string[]
  trustedPaths: string[]
  restrictedIds: string[]
  restrictedPaths: string[]
}

function emptyStore(): TrustStore {
  return {
    trustedIds: [],
    trustedPaths: [],
    restrictedIds: [],
    restrictedPaths: [],
  }
}

/** Normalize project path for stable trust lookups across slash styles / trailing separators. */
export function normalizeProjectPath(path: string): string {
  return path.trim().replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase()
}

function migrateLegacyRunTrust(): TrustStore | null {
  try {
    const raw = localStorage.getItem(RUN_TRUST_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ids?: unknown; paths?: unknown }
    const trustedIds = Array.isArray(parsed.ids)
      ? parsed.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    const trustedPaths = Array.isArray(parsed.paths)
      ? parsed.paths
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .map(normalizeProjectPath)
      : []
    if (trustedIds.length === 0 && trustedPaths.length === 0) return null
    return {
      trustedIds: [...new Set(trustedIds)],
      trustedPaths: [...new Set(trustedPaths)],
      restrictedIds: [],
      restrictedPaths: [],
    }
  } catch {
    return null
  }
}

function readStore(): TrustStore {
  try {
    const raw = localStorage.getItem(WORKSPACE_TRUST_STORAGE_KEY)
    if (!raw) {
      const migrated = migrateLegacyRunTrust()
      if (migrated) {
        writeStore(migrated)
        return migrated
      }
      return emptyStore()
    }
    const parsed = JSON.parse(raw) as Partial<TrustStore>
    const trustedIds = Array.isArray(parsed.trustedIds)
      ? parsed.trustedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    const trustedPaths = Array.isArray(parsed.trustedPaths)
      ? parsed.trustedPaths
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .map(normalizeProjectPath)
      : []
    const restrictedIds = Array.isArray(parsed.restrictedIds)
      ? parsed.restrictedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    const restrictedPaths = Array.isArray(parsed.restrictedPaths)
      ? parsed.restrictedPaths
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .map(normalizeProjectPath)
      : []
    return {
      trustedIds: [...new Set(trustedIds)],
      trustedPaths: [...new Set(trustedPaths)],
      restrictedIds: [...new Set(restrictedIds)],
      restrictedPaths: [...new Set(restrictedPaths)],
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: TrustStore) {
  try {
    localStorage.setItem(WORKSPACE_TRUST_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Quota / private mode — trust simply will not persist.
  }
  window.dispatchEvent(new Event(WORKSPACE_TRUST_CHANGED_EVENT))
}

function removeFromLists(
  store: TrustStore,
  project: Pick<Project, 'id' | 'path'>,
): TrustStore {
  const path = normalizeProjectPath(project.path)
  return {
    trustedIds: store.trustedIds.filter(id => id !== project.id),
    trustedPaths: store.trustedPaths.filter(p => p !== path),
    restrictedIds: store.restrictedIds.filter(id => id !== project.id),
    restrictedPaths: store.restrictedPaths.filter(p => p !== path),
  }
}

/** `trusted` | `restricted` | `undecided` (never asked). */
export function getWorkspaceTrust(
  project: Pick<Project, 'id' | 'path'>,
): WorkspaceTrustLevel | 'undecided' {
  const store = readStore()
  const path = normalizeProjectPath(project.path)
  if (store.trustedIds.includes(project.id) || store.trustedPaths.includes(path)) {
    return 'trusted'
  }
  if (store.restrictedIds.includes(project.id) || store.restrictedPaths.includes(path)) {
    return 'restricted'
  }
  return 'undecided'
}

export function isProjectTrusted(project: Pick<Project, 'id' | 'path'>): boolean {
  return getWorkspaceTrust(project) === 'trusted'
}

export function isProjectRestricted(project: Pick<Project, 'id' | 'path'>): boolean {
  return getWorkspaceTrust(project) === 'restricted'
}

export function trustProject(project: Pick<Project, 'id' | 'path'>): void {
  const path = normalizeProjectPath(project.path)
  const store = removeFromLists(readStore(), project)
  if (!store.trustedIds.includes(project.id)) store.trustedIds.push(project.id)
  if (path && !store.trustedPaths.includes(path)) store.trustedPaths.push(path)
  writeStore(store)
}

export function restrictProject(project: Pick<Project, 'id' | 'path'>): void {
  const path = normalizeProjectPath(project.path)
  const store = removeFromLists(readStore(), project)
  if (!store.restrictedIds.includes(project.id)) store.restrictedIds.push(project.id)
  if (path && !store.restrictedPaths.includes(path)) store.restrictedPaths.push(path)
  writeStore(store)
}

/** Clear decision so the next open asks again. */
export function untrustProject(project: Pick<Project, 'id' | 'path'>): void {
  writeStore(removeFromLists(readStore(), project))
}

/**
 * Sync currently trusted project roots into the Rust sandbox.
 * Always refreshes project roots first — native trust sync only accepts
 * paths that are already registered as project roots.
 */
export async function pushTrustedRootsToNative(
  projects: Array<Pick<Project, 'id' | 'path' | 'ephemeral'>>,
): Promise<void> {
  await syncRootsFromProjects(projects)
  const roots = projects
    .filter(project => project.ephemeral || isProjectTrusted(project))
    .map(project => project.path)
  await syncTrustedRoots(roots)
}

/**
 * Ask once when opening a project (VS Code–style workspace trust).
 * Ephemeral scratch projects are auto-trusted.
 * @returns trust level, or `false` if the user cancelled.
 */
export async function ensureWorkspaceTrust(
  project: Pick<Project, 'id' | 'path' | 'name' | 'ephemeral'>,
): Promise<WorkspaceTrustLevel | false> {
  if (project.ephemeral) {
    trustProject(project)
    return 'trusted'
  }

  const current = getWorkspaceTrust(project)
  if (current === 'trusted' || current === 'restricted') return current

  const choice = await confirmDialog({
    title: translate('是否信任此项目？'),
    message: translate(
      '信任「{name}」中的文件作者后，可编辑文件、使用终端并运行项目脚本。受限模式下只能浏览，不会执行项目内命令。',
      { name: project.name },
    ),
    detail: project.path,
    kind: 'warning',
    confirmLabel: translate('信任并继续'),
    altLabel: translate('受限模式'),
    cancelLabel: translate('取消'),
  })

  if (choice === false) return false
  if (choice === 'alt') {
    restrictProject(project)
    return 'restricted'
  }
  trustProject(project)
  return 'trusted'
}
