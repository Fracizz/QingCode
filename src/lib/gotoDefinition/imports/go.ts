import type { EditorState } from '@codemirror/state'
import { joinPath, firstExistingFile } from '../pathUtils'
import { editorStateForFile } from '../loadFileState'
import { findSymbolInState } from '../sameFile'
import { safeInvoke } from '../../tauri'
import type { DefinitionTarget, IdentifierToken } from '../types'

/**
 * Go: `import "pkg/path"` and same-package symbols via file search fallback.
 */
export async function resolveGoImport(
  state: EditorState,
  token: IdentifierToken,
  _filePath: string,
  projectRoots: string[],
): Promise<DefinitionTarget[]> {
  const line = state.doc.lineAt(token.from)
  const pkg = parseGoImportLine(line.text)
  if (!pkg) return []

  // Alias or last path segment used as package name
  const alias = pkg.alias
  const lastSeg = pkg.path.split('/').filter(Boolean).pop() ?? ''
  if (token.name !== alias && token.name !== lastSeg) {
    // Might be clicking a segment inside the string — open package dir file
    if (!pkg.path.includes(token.name)) return []
  }

  const files = await findGoPackageFiles(pkg.path, projectRoots)
  if (files.length === 0) return []
  return files.slice(0, 3).map(path => ({ path, line: 1, label: 'package' }))
}

export function parseGoImportLine(
  line: string,
): { path: string; alias?: string } | null {
  const trimmed = line.trim()
  // import alias "path"  or  import "path"
  const single = trimmed.match(/^import\s+(?:(\w+)\s+)?["']([^"']+)["']/)
  if (single) {
    return { alias: single[1], path: single[2]! }
  }
  // inside import ( ) block: alias "path"
  const inBlock = trimmed.match(/^(?:(\w+)\s+)?["']([^"']+)["']/)
  if (inBlock && (trimmed.includes('"') || trimmed.includes("'"))) {
    return { alias: inBlock[1], path: inBlock[2]! }
  }
  return null
}

async function findGoPackageFiles(importPath: string, projectRoots: string[]): Promise<string[]> {
  const last = importPath.split('/').filter(Boolean).pop()
  if (!last) return []
  const out: string[] = []

  for (const root of projectRoots) {
    // Common layouts: <root>/<importPath>/*.go or suffix match
    const dir = joinPath(root, importPath)
    const direct = await firstExistingFile([
      joinPath(dir, `${last}.go`),
      joinPath(dir, 'doc.go'),
    ])
    if (direct) {
      out.push(direct)
      continue
    }
    // Fuzzy: search file named like package
    try {
      const hits = await safeInvoke<{ path: string }[]>('快速打开文件', 'search_files', {
        root,
        query: `${last}.go`,
        ignoreCase: true,
        fuzzy: false,
        matchSuffix: true,
        extension: 'go',
        extensions: null,
        limit: 5,
        excludePatterns: [],
        useIgnoreFiles: true,
        followSymlinks: false,
      })
      for (const hit of hits ?? []) {
        if (hit.path.replace(/\\/g, '/').includes(`/${last}/`) || hit.path.endsWith(`${last}.go`)) {
          out.push(hit.path.replace(/\\/g, '/'))
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out)]
}

/** Open a Go file and find a top-level func/type by name (used after package open). */
export async function findGoSymbol(path: string, name: string): Promise<DefinitionTarget[]> {
  const modState = await editorStateForFile(path)
  if (!modState) return [{ path, line: 1 }]
  return findSymbolInState(modState, name, path)
}
