import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacySettings } from './migrateLegacySettings'

// `migrateLegacySettings` only touches the global `localStorage` (getItem/setItem),
// resolved at call time. The default Vitest `node` environment exposes a
// non-functional localStorage via node's `--localstorage-file` flag, so we stub a
// minimal Map-backed shim instead of relying on jsdom. This keeps the test hermetic
// and environment-agnostic; the module reads `localStorage` from globalThis when
// invoked, so stubbing before each call is sufficient.

const LEGACY_KEYS = [
  'nestcode:terminal-panel',
  'nestcode:theme',
  'nestcode:sidebar-width',
  'nestcode:font-settings',
  'nestcode:terminal-layout',
] as const

const CURRENT_KEYS = [
  'qingcode:terminal-panel',
  'qingcode:theme',
  'qingcode:sidebar-width',
  'qingcode:font-settings',
  'qingcode:terminal-layout',
] as const

const MIGRATED_FLAG = 'qingcode:legacy-ls-migrated'

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  } as Storage
}

describe('migrateLegacySettings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageStub())
  })

  afterEach(() => {
    // Restore the real global so the stub does not leak into other test files
    // sharing this worker (the locale store reads language from localStorage).
    vi.unstubAllGlobals()
  })

  it('copies legacy nestcode:* values into qingcode:* keys when current key is absent', () => {
    localStorage.setItem(LEGACY_KEYS[0], 'dark')
    localStorage.setItem(LEGACY_KEYS[1], 'forest')

    migrateLegacySettings()

    expect(localStorage.getItem(CURRENT_KEYS[0])).toBe('dark')
    expect(localStorage.getItem(CURRENT_KEYS[1])).toBe('forest')
    // Legacy keys are left in place (copy, not move).
    expect(localStorage.getItem(LEGACY_KEYS[0])).toBe('dark')
    expect(localStorage.getItem(MIGRATED_FLAG)).toBe('1')
  })

  it('does not overwrite an existing qingcode:* key', () => {
    localStorage.setItem(LEGACY_KEYS[1], 'forest')
    localStorage.setItem(CURRENT_KEYS[1], 'ocean')

    migrateLegacySettings()

    expect(localStorage.getItem(CURRENT_KEYS[1])).toBe('ocean')
    expect(localStorage.getItem(MIGRATED_FLAG)).toBe('1')
  })

  it('skips legacy keys that have no value', () => {
    localStorage.setItem(LEGACY_KEYS[2], '280')

    migrateLegacySettings()

    expect(localStorage.getItem(CURRENT_KEYS[2])).toBe('280')
    expect(localStorage.getItem(CURRENT_KEYS[0])).toBeNull()
    expect(localStorage.getItem(MIGRATED_FLAG)).toBe('1')
  })

  it('short-circuits when the migrated flag is already set', () => {
    localStorage.setItem(MIGRATED_FLAG, '1')
    // A legacy key that WOULD have migrated is present; it must stay untouched.
    localStorage.setItem(LEGACY_KEYS[0], 'dark')

    migrateLegacySettings()

    expect(localStorage.getItem(CURRENT_KEYS[0])).toBeNull()
    expect(localStorage.getItem(MIGRATED_FLAG)).toBe('1')
  })

  it('writes the migrated flag even when there is nothing to migrate', () => {
    migrateLegacySettings()

    expect(localStorage.getItem(MIGRATED_FLAG)).toBe('1')
  })

  it('runs only once across repeated calls', () => {
    localStorage.setItem(LEGACY_KEYS[0], 'dark')

    migrateLegacySettings()
    expect(localStorage.getItem(CURRENT_KEYS[0])).toBe('dark')

    // Second invocation must short-circuit at the flag; remove the current key
    // to prove it is NOT re-migrated from the legacy key.
    localStorage.removeItem(CURRENT_KEYS[0])
    migrateLegacySettings()

    expect(localStorage.getItem(CURRENT_KEYS[0])).toBeNull()
    expect(localStorage.getItem(MIGRATED_FLAG)).toBe('1')
  })
})
