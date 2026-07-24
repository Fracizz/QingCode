import type { EditorState } from '@codemirror/state'
import { firstExistingFile, joinPath } from '../pathUtils'
import { editorStateForFile } from '../loadFileState'
import { findSymbolInState } from '../sameFile'
import type { DefinitionTarget, IdentifierToken } from '../types'

const SOURCE_ROOT_SUFFIXES = ['', 'src', 'src/main/java', 'src/test/java', 'app/src/main/java']

/**
 * Java: `import com.foo.Bar` → …/com/foo/Bar.java under common source roots.
 */
export async function resolveJavaImport(
  state: EditorState,
  token: IdentifierToken,
  _filePath: string,
  projectRoots: string[],
): Promise<DefinitionTarget[]> {
  const line = state.doc.lineAt(token.from)
  const info = parseJavaImportLine(line.text)
  if (!info) return []

  const parts = info.dotted.split('.').filter(Boolean)
  if (!parts.includes(token.name) && info.alias !== token.name && parts[parts.length - 1] !== token.name) {
    return []
  }

  const typeName = parts[parts.length - 1]!
  const pkgParts = parts.slice(0, -1)
  const files = await resolveJavaType(pkgParts, typeName, projectRoots)
  const out: DefinitionTarget[] = []
  for (const file of files) {
    const modState = await editorStateForFile(file)
    if (!modState) {
      out.push({ path: file, line: 1, label: 'type' })
      continue
    }
    const symbols = findSymbolInState(modState, typeName, file)
    if (symbols.length > 0) out.push(...symbols)
    else out.push({ path: file, line: 1, label: 'type' })
  }
  return out
}

export function parseJavaImportLine(
  line: string,
): { dotted: string; static?: boolean; alias?: string } | null {
  const trimmed = line.trim()
  const m = trimmed.match(/^import\s+(static\s+)?([\w.]+)(?:\s*\.\*)?\s*;/)
  if (!m) return null
  return { dotted: m[2]!, static: Boolean(m[1]) }
}

async function resolveJavaType(
  pkgParts: string[],
  typeName: string,
  projectRoots: string[],
): Promise<string[]> {
  const found: string[] = []
  for (const root of projectRoots) {
    for (const suffix of SOURCE_ROOT_SUFFIXES) {
      const base = suffix ? joinPath(root, suffix) : root
      const candidate = joinPath(base, ...pkgParts, `${typeName}.java`)
      const hit = await firstExistingFile([candidate])
      if (hit) found.push(hit)
    }
  }
  return [...new Set(found)]
}
