import type { EditorState } from '@codemirror/state'
import { parentPath } from '../../../utils/fileReferences'
import { firstExistingFile, joinPath } from '../pathUtils'
import { editorStateForFile } from '../loadFileState'
import { findSymbolInState } from '../sameFile'
import type { DefinitionTarget, IdentifierToken } from '../types'

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

/**
 * Resolve ES `import` / `export … from` / `require()` for JS/TS/JSX/TSX.
 */
export async function resolveJavaScriptImport(
  state: EditorState,
  token: IdentifierToken,
  filePath: string,
  projectRoots: string[],
): Promise<DefinitionTarget[]> {
  const line = state.doc.lineAt(token.from)
  const info = parseJsImportLine(line.text)
  if (!info) return []

  const isOnSpecifier =
    info.specifierIncludes?.(token.name) ||
    tokenTouchesSpecifier(state, token, info.specifierRaw, line.from)

  // Clicking a local binding: `import { foo as bar }` / `import foo from`
  const local = info.names.find(n => n.local === token.name)
  if (local && !isOnSpecifier) {
    const resolved = await resolveJsSpecifier(info.specifier, filePath, projectRoots)
    if (!resolved) return []
    const modState = await editorStateForFile(resolved)
    if (!modState) return [{ path: resolved, line: 1, label: 'module' }]
    const exported = local.exported === 'default' ? 'default' : local.exported
    if (exported === 'default') {
      // Best-effort: open module; try common default export names matching file.
      const baseName = resolved.split('/').pop()?.replace(/\.\w+$/, '') ?? token.name
      const symbols = findSymbolInState(modState, baseName, resolved)
      return symbols.length > 0 ? symbols : [{ path: resolved, line: 1, label: 'module' }]
    }
    if (exported === '*') {
      return [{ path: resolved, line: 1, label: 'module' }]
    }
    const symbols = findSymbolInState(modState, exported, resolved)
    return symbols.length > 0 ? symbols : [{ path: resolved, line: 1, label: 'module' }]
  }

  // Clicking inside the module string
  if (isOnSpecifier || info.names.some(n => n.exported === token.name && n.local !== token.name)) {
    const resolved = await resolveJsSpecifier(info.specifier, filePath, projectRoots)
    if (!resolved) return []
    return [{ path: resolved, line: 1, label: 'module' }]
  }

  return []
}

type JsImportName = { exported: string; local: string }

type JsImportLine = {
  specifier: string
  specifierRaw: string
  names: JsImportName[]
  specifierIncludes?: (name: string) => boolean
}

export function parseJsImportLine(line: string): JsImportLine | null {
  const trimmed = line.trim()

  // import x from 'mod' / import * as x from 'mod' / import { a as b } from 'mod'
  const fromMatch = trimmed.match(
    /^import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"]/,
  )
  if (fromMatch) {
    const names = parseJsImportClause(fromMatch[1]!)
    return { specifier: fromMatch[2]!, specifierRaw: fromMatch[2]!, names }
  }

  // import 'mod'
  const sideMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/)
  if (sideMatch) {
    return { specifier: sideMatch[1]!, specifierRaw: sideMatch[1]!, names: [] }
  }

  // export … from 'mod'
  const exportFrom = trimmed.match(/^export\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"]/)
  if (exportFrom) {
    const names = parseJsImportClause(exportFrom[1]!)
    return { specifier: exportFrom[2]!, specifierRaw: exportFrom[2]!, names }
  }

  // const x = require('mod')
  const requireMatch = trimmed.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  )
  if (requireMatch) {
    return {
      specifier: requireMatch[2]!,
      specifierRaw: requireMatch[2]!,
      names: [{ exported: '*', local: requireMatch[1]! }],
    }
  }

  return null
}

function parseJsImportClause(clause: string): JsImportName[] {
  const c = clause.trim()
  if (!c) return []
  if (c.startsWith('*')) {
    const m = c.match(/^\*\s+as\s+(\w+)/)
    return m ? [{ exported: '*', local: m[1]! }] : []
  }
  const names: JsImportName[] = []
  // default import possibly with namespace
  const defaultAndRest = c.match(/^(\w+)(?:\s*,\s*(.*))?$/)
  if (defaultAndRest && !c.startsWith('{')) {
    names.push({ exported: 'default', local: defaultAndRest[1]! })
    if (defaultAndRest[2]?.trim().startsWith('{')) {
      names.push(...parseNamedImports(defaultAndRest[2]!))
    } else if (defaultAndRest[2]?.trim().startsWith('*')) {
      const m = defaultAndRest[2]!.match(/\*\s+as\s+(\w+)/)
      if (m) names.push({ exported: '*', local: m[1]! })
    }
    return names
  }
  if (c.startsWith('{')) {
    return parseNamedImports(c)
  }
  return names
}

function parseNamedImports(block: string): JsImportName[] {
  const inner = block.replace(/^\{/, '').replace(/\}$/, '')
  return inner
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const m = s.match(/^(\w+)(?:\s+as\s+(\w+))?$/)
      if (!m) return null
      return { exported: m[1]!, local: m[2] ?? m[1]! }
    })
    .filter((x): x is JsImportName => Boolean(x))
}

function tokenTouchesSpecifier(
  state: EditorState,
  token: IdentifierToken,
  specifier: string,
  lineFrom: number,
): boolean {
  const line = state.doc.lineAt(token.from)
  const idx = line.text.indexOf(specifier)
  if (idx < 0) return false
  const from = lineFrom + idx
  const to = from + specifier.length
  return token.from >= from && token.to <= to
}

export async function resolveJsSpecifier(
  specifier: string,
  filePath: string,
  projectRoots: string[],
): Promise<string | null> {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const baseDir = parentPath(filePath)
    return resolveRelativeJs(baseDir, specifier)
  }
  // Bare specifier: try under each project root (and common src/)
  for (const root of projectRoots) {
    const hit =
      (await resolveRelativeJs(root, specifier)) ||
      (await resolveRelativeJs(joinPath(root, 'src'), specifier))
    if (hit) return hit
  }
  return null
}

async function resolveRelativeJs(baseDir: string, specifier: string): Promise<string | null> {
  const abs = joinPath(baseDir, specifier)
  const candidates = [
    abs,
    ...JS_EXTS.map(ext => abs + ext),
    ...JS_EXTS.map(ext => joinPath(abs, `index${ext}`)),
  ]
  return firstExistingFile(candidates)
}
