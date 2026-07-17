import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_TRUST_STORAGE_KEY,
  RUN_TRUST_STORAGE_KEY,
  getWorkspaceTrust,
  isProjectRestricted,
  isProjectTrusted,
  normalizeProjectPath,
  restrictProject,
  trustProject,
  untrustProject,
} from './workspaceTrust'

const project = { id: 'p1', path: 'D:\\Work\\Demo\\' }

function installMemoryLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  })
}

describe('workspaceTrust', () => {
  beforeEach(() => {
    installMemoryLocalStorage()
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes project paths', () => {
    expect(normalizeProjectPath('D:\\Work\\Demo\\')).toBe('d:/work/demo')
    expect(normalizeProjectPath('/home/me/proj/')).toBe('/home/me/proj')
  })

  it('starts undecided then trusts and restricts', () => {
    expect(getWorkspaceTrust(project)).toBe('undecided')
    trustProject(project)
    expect(isProjectTrusted(project)).toBe(true)
    expect(isProjectRestricted(project)).toBe(false)

    restrictProject(project)
    expect(isProjectTrusted(project)).toBe(false)
    expect(isProjectRestricted(project)).toBe(true)
    expect(getWorkspaceTrust(project)).toBe('restricted')
  })

  it('clears decision with untrustProject', () => {
    trustProject(project)
    untrustProject(project)
    expect(getWorkspaceTrust(project)).toBe('undecided')
  })

  it('migrates legacy run-trust storage', () => {
    localStorage.setItem(
      RUN_TRUST_STORAGE_KEY,
      JSON.stringify({ ids: ['legacy'], paths: ['C:/old/project'] }),
    )
    expect(getWorkspaceTrust({ id: 'legacy', path: 'C:\\other' })).toBe('trusted')
    expect(getWorkspaceTrust({ id: 'x', path: 'C:/old/project/' })).toBe('trusted')
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_TRUST_STORAGE_KEY) ?? '{}') as {
      trustedIds: string[]
    }
    expect(stored.trustedIds).toContain('legacy')
  })
})
