import type { EditorState } from '@codemirror/state'
import { parentPath } from '../../../utils/fileReferences'
import { ancestorDirs, firstExistingFile, joinPath, resolveDottedModule } from '../pathUtils'
import { editorStateForFile } from '../loadFileState'
import { findSymbolInState } from '../sameFile'
import type { DefinitionTarget, IdentifierToken } from '../types'

const PY_EXTS = ['.py']

/**
 * Resolve Python import / from-import targets for the identifier under the cursor.
 */
export async function resolvePythonImport(
  state: EditorState,
  token: IdentifierToken,
  filePath: string,
  projectRoots: string[],
): Promise<DefinitionTarget[]> {
  const line = state.doc.lineAt(token.from)
  const text = line.text
  const importInfo = parsePythonImportLine(text)
  if (!importInfo) return []

  const bases = [...ancestorDirs(filePath, projectRoots), ...projectRoots.map(r => r)]
  const uniqueBases = dedupePaths(bases)

  // Cursor on a module segment in `import a.b` / `from a.b import …`
  const moduleHit = moduleSegmentAt(importInfo, text, token)
  if (moduleHit) {
    const files = await resolveDottedModule(
      moduleHit.relative ? relativeBases(filePath, moduleHit.relative, uniqueBases) : uniqueBases,
      moduleHit.dotted,
      PY_EXTS,
      true,
    )
    return files.map(path => ({ path, line: 1, label: 'module' }))
  }

  // Cursor on imported name: `from x import foo as bar` → resolve foo (or alias)
  if (importInfo.kind === 'from' && importInfo.names.some(n => n.local === token.name)) {
    const nameInfo = importInfo.names.find(n => n.local === token.name)!
    const exportName = nameInfo.exported
    const moduleBases = importInfo.relative
      ? relativeBases(filePath, importInfo.relative, uniqueBases)
      : uniqueBases
    if (!importInfo.module && importInfo.relative) {
      // from . import name → look in package __init__ or sibling modules
      const pkgFiles = await resolveRelativePackageNames(
        filePath,
        importInfo.relative,
        exportName,
        uniqueBases,
      )
      return pkgFiles
    }
    const moduleFiles = importInfo.module
      ? await resolveDottedModule(moduleBases, importInfo.module, PY_EXTS, true)
      : []
    const out: DefinitionTarget[] = []
    for (const modPath of moduleFiles) {
      const modState = await editorStateForFile(modPath)
      if (!modState) {
        out.push({ path: modPath, line: 1, label: 'module' })
        continue
      }
      const symbols = findSymbolInState(modState, exportName, modPath)
      if (symbols.length > 0) out.push(...symbols)
      else out.push({ path: modPath, line: 1, label: 'module' })
    }
    return out
  }

  return []
}

/**
 * When the cursor is on a use of an imported name (not on the import line),
 * find matching `from … import name` / `import name` in this file and resolve into the module.
 */
export async function resolvePythonImportedNameAnywhere(
  state: EditorState,
  token: IdentifierToken,
  filePath: string,
  projectRoots: string[],
): Promise<DefinitionTarget[]> {
  const out: DefinitionTarget[] = []
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo)
    // Skip the line under the cursor — handled by resolvePythonImport already.
    if (token.from >= line.from && token.from < line.to) continue
    const info = parsePythonImportLine(line.text)
    if (!info) continue

    let matches = false
    if (info.kind === 'from') {
      matches = info.names.some(n => n.local === token.name)
    } else {
      matches = info.modules.some(mod => {
        const local = mod.alias ?? mod.dotted.split('.').pop()
        return local === token.name
      })
    }
    if (!matches) continue

    const fakeToken: IdentifierToken = {
      name: token.name,
      from: line.from,
      to: line.from + Math.min(1, line.text.length),
    }
    const hits = await resolvePythonImport(state, fakeToken, filePath, projectRoots)
    out.push(...hits)
  }
  return out
}

type ImportName = { exported: string; local: string }

type PythonImportLine =
  | {
      kind: 'import'
      modules: { dotted: string; alias?: string }[]
      relative?: never
      module?: never
      names?: never
    }
  | {
      kind: 'from'
      relative: number
      module: string
      names: ImportName[]
    }

export function parsePythonImportLine(line: string): PythonImportLine | null {
  const trimmed = line.trim()
  const fromMatch = trimmed.match(
    /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/,
  )
  if (fromMatch) {
    const relative = fromMatch[1]?.length ?? 0
    const module = (fromMatch[2] ?? '').replace(/\.$/, '')
    const namesPart = fromMatch[3]!.replace(/\\\s*$/, '').trim()
    if (namesPart === '(') return null // multi-line — skip for v1
    const names = parseImportNames(namesPart)
    if (names.length === 0 && namesPart !== '*') return null
    return { kind: 'from', relative, module, names }
  }

  const importMatch = trimmed.match(/^import\s+(.+)$/)
  if (importMatch) {
    const modules: { dotted: string; alias?: string }[] = []
    for (const part of importMatch[1]!.split(',')) {
      const m = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/)
      if (!m) continue
      modules.push({ dotted: m[1]!, alias: m[2] })
    }
    if (modules.length === 0) return null
    return { kind: 'import', modules }
  }
  return null
}

function parseImportNames(part: string): ImportName[] {
  if (part === '*') return []
  return part
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const m = s.match(/^(\w+)(?:\s+as\s+(\w+))?$/)
      if (!m) return null
      return { exported: m[1]!, local: m[2] ?? m[1]! }
    })
    .filter((x): x is ImportName => Boolean(x))
}

function moduleSegmentAt(
  info: PythonImportLine,
  lineText: string,
  token: IdentifierToken,
): { dotted: string; relative?: number } | null {
  const lineStart = lineText.length // unused; we work with token.name in structured info
  void lineStart
  if (info.kind === 'import') {
    for (const mod of info.modules) {
      if (mod.alias === token.name) {
        return { dotted: mod.dotted }
      }
      const parts = mod.dotted.split('.')
      if (parts.includes(token.name)) {
        const idx = parts.indexOf(token.name)
        return { dotted: parts.slice(0, idx + 1).join('.') }
      }
    }
  }
  if (info.kind === 'from' && info.module) {
    const parts = info.module.split('.')
    if (parts.includes(token.name)) {
      const idx = parts.indexOf(token.name)
      return {
        dotted: parts.slice(0, idx + 1).join('.'),
        relative: info.relative || undefined,
      }
    }
  }
  return null
}

function relativeBases(filePath: string, dots: number, fallback: string[]): string[] {
  let dir = parentPath(filePath)
  // from . → package containing file; from .. → parent package
  for (let i = 1; i < dots; i++) {
    dir = parentPath(dir)
  }
  return dedupePaths([dir, ...fallback])
}

async function resolveRelativePackageNames(
  filePath: string,
  dots: number,
  name: string,
  bases: string[],
): Promise<DefinitionTarget[]> {
  const pkgBases = relativeBases(filePath, dots || 1, bases)
  const sibling = await firstExistingFile(
    pkgBases.flatMap(base => [joinPath(base, `${name}.py`), joinPath(base, name, '__init__.py')]),
  )
  if (!sibling) return []
  const modState = await editorStateForFile(sibling)
  if (!modState) return [{ path: sibling, line: 1, label: 'module' }]
  const symbols = findSymbolInState(modState, name, sibling)
  return symbols.length > 0 ? symbols : [{ path: sibling, line: 1, label: 'module' }]
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const key = p.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p.replace(/\\/g, '/'))
  }
  return out
}
