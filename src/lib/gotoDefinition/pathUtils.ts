import { safeInvoke } from '../tauri'
import { normalizePath, parentPath } from '../../utils/fileReferences'
import { guessLanguage } from '../../utils/editorHelpers'

export function joinPath(...parts: string[]): string {
  const cleaned = parts
    .filter(Boolean)
    .map((part, index) => {
      const n = part.replace(/\\/g, '/')
      if (index === 0) return n.replace(/\/+$/, '')
      return n.replace(/^\/+|\/+$/g, '')
    })
    .filter(Boolean)
  return cleaned.join('/')
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await safeInvoke<{ size: number; is_dir: boolean }>('读取文件信息', 'file_stat', {
      path,
    })
    return !stat.is_dir
  } catch {
    return false
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await safeInvoke<{ size: number; is_dir: boolean }>('读取文件信息', 'file_stat', {
      path,
    })
    return stat.is_dir
  } catch {
    return false
  }
}

/** First existing file among candidates (absolute paths). */
export async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return normalizePath(candidate)
  }
  return null
}

/**
 * Resolve `a.b.c` style modules against bases:
 * - `base/a/b/c.py` / `base/a/b/c/__init__.py` (and other extensions)
 */
export async function resolveDottedModule(
  bases: string[],
  dotted: string,
  fileExtensions: string[],
  allowInit = true,
): Promise<string[]> {
  const parts = dotted.split('.').filter(Boolean)
  if (parts.length === 0) return []
  const found: string[] = []
  const seen = new Set<string>()

  for (const base of bases) {
    const dir = joinPath(base, ...parts.slice(0, -1))
    const last = parts[parts.length - 1]!
    const candidates: string[] = []
    for (const ext of fileExtensions) {
      candidates.push(joinPath(base, ...parts) + ext)
      if (parts.length > 0) {
        candidates.push(joinPath(dir, last) + ext)
      }
    }
    if (allowInit) {
      for (const ext of fileExtensions) {
        candidates.push(joinPath(base, ...parts, `__init__${ext}`))
      }
    }
    for (const candidate of candidates) {
      const norm = normalizePath(candidate)
      if (seen.has(norm.toLowerCase())) continue
      if (await fileExists(norm)) {
        seen.add(norm.toLowerCase())
        found.push(norm)
      }
    }
  }
  return found
}

/** Walk parent directories of a file (including the file's directory). */
export function ancestorDirs(filePath: string, stopAtRoots: string[]): string[] {
  const stops = new Set(stopAtRoots.map(r => normalizePath(r).toLowerCase()))
  const out: string[] = []
  let current = parentPath(filePath)
  for (let i = 0; i < 32 && current; i++) {
    const norm = normalizePath(current)
    out.push(norm)
    if (stops.has(norm.toLowerCase())) break
    const next = parentPath(norm)
    if (normalizePath(next).toLowerCase() === norm.toLowerCase()) break
    current = next
  }
  return out
}

export function languageIdForPath(path: string): string {
  return guessLanguage(path)
}
