const LEGACY_PREFIX = 'nestcode:' // former product id; kept for one-time localStorage migration
const CURRENT_PREFIX = 'qingcode:'

/** One-time migration marker; once set, subsequent starts skip the localStorage scan. */
const LEGACY_LS_MIGRATED_KEY = 'qingcode:legacy-ls-migrated'

const KEYS = [
  'terminal-panel',
  'theme',
  'sidebar-width',
  'font-settings',
  'terminal-layout',
] as const

/**
 * One-time migration from legacy localStorage keys.
 *
 * Version-guarded by {@link LEGACY_LS_MIGRATED_KEY}: once the pass has run
 * successfully the marker is written and later starts short-circuit, so we
 * do not re-scan `nestcode:*` keys on every launch. The migration logic itself
 * is retained (not deleted) so users upgrading from the legacy product id for
 * the first time still recover their preferences.
 */
export function migrateLegacySettings() {
  if (localStorage.getItem(LEGACY_LS_MIGRATED_KEY) === '1') return

  for (const key of KEYS) {
    const legacyKey = `${LEGACY_PREFIX}${key}`
    const currentKey = `${CURRENT_PREFIX}${key}`
    const legacyValue = localStorage.getItem(legacyKey)
    if (legacyValue == null || localStorage.getItem(currentKey) != null) continue
    localStorage.setItem(currentKey, legacyValue)
  }

  localStorage.setItem(LEGACY_LS_MIGRATED_KEY, '1')
}
