const LEGACY_PREFIX = 'nestcode:' // former product id; kept for one-time localStorage migration
const CURRENT_PREFIX = 'qingcode:'

const KEYS = [
  'terminal-panel',
  'theme',
  'sidebar-width',
  'font-settings',
  'terminal-layout',
] as const

/** One-time migration from legacy localStorage keys. */
export function migrateLegacySettings() {
  for (const key of KEYS) {
    const legacyKey = `${LEGACY_PREFIX}${key}`
    const currentKey = `${CURRENT_PREFIX}${key}`
    const legacyValue = localStorage.getItem(legacyKey)
    if (legacyValue == null || localStorage.getItem(currentKey) != null) continue
    localStorage.setItem(currentKey, legacyValue)
  }
}
