/** Shape of a user-installed (or built-in) UI locale JSON package. */
export type LocalePackage = {
  locale: string
  label: string
  messages: Record<string, string>
  /** Absolute path when loaded from disk. */
  path?: string
  builtin?: boolean
}

const LOCALE_CODE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

export function isValidLocaleCode(code: string): boolean {
  return LOCALE_CODE_RE.test(code) && code.length <= 32
}

/** Parse / normalize a locale JSON object. Returns null when invalid. */
export function parseLocalePackage(raw: unknown, path?: string): LocalePackage | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const locale = typeof obj.locale === 'string' ? obj.locale.trim() : ''
  if (!isValidLocaleCode(locale)) return null
  const label =
    typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : locale
  if (!obj.messages || typeof obj.messages !== 'object' || Array.isArray(obj.messages)) {
    return null
  }
  const messages: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj.messages as Record<string, unknown>)) {
    if (typeof key === 'string' && typeof value === 'string') {
      messages[key] = value
    }
  }
  return { locale, label, messages, path }
}

/** Merge a user pack onto built-ins (user messages win; label from user when set). */
export function mergeLocalePackage(
  packages: Record<string, LocalePackage>,
  pack: LocalePackage,
): Record<string, LocalePackage> {
  const existing = packages[pack.locale]
  if (!existing) {
    return { ...packages, [pack.locale]: { ...pack, builtin: false } }
  }
  return {
    ...packages,
    [pack.locale]: {
      ...existing,
      label: pack.label || existing.label,
      messages: { ...existing.messages, ...pack.messages },
      path: pack.path ?? existing.path,
      builtin: existing.builtin,
    },
  }
}
