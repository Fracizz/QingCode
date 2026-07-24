import type { EditorState } from '@codemirror/state'
import { parentPath } from '../../../utils/fileReferences'
import { ancestorDirs, firstExistingFile, joinPath } from '../pathUtils'
import { editorStateForFile } from '../loadFileState'
import { findSymbolInState } from '../sameFile'
import type { DefinitionTarget, IdentifierToken } from '../types'

/**
 * Rust: `use crate::foo::bar` / `mod foo` → src/foo.rs or foo/mod.rs
 */
export async function resolveRustImport(
  state: EditorState,
  token: IdentifierToken,
  filePath: string,
  projectRoots: string[],
): Promise<DefinitionTarget[]> {
  const line = state.doc.lineAt(token.from)
  const text = line.text.trim()

  const modMatch = text.match(/^mod\s+(\w+)\s*;/)
  if (modMatch && modMatch[1] === token.name) {
    const file = await resolveRustModFile(filePath, token.name, projectRoots)
    return file ? [{ path: file, line: 1, label: 'mod' }] : []
  }

  const usePath = parseRustUsePath(text)
  if (!usePath) return []

  const parts = usePath.parts
  if (!parts.includes(token.name) && usePath.alias !== token.name) return []

  // Alias → whole path; segment → prefix through that segment
  let targetParts = parts
  if (usePath.alias === token.name) {
    targetParts = parts
  } else {
    const idx = parts.indexOf(token.name)
    if (idx >= 0) targetParts = parts.slice(0, idx + 1)
  }

  // crate:: / self:: / super:: relative to crate root / current
  const files = await resolveRustPath(targetParts, filePath, projectRoots, usePath.root)
  const out: DefinitionTarget[] = []
  for (const file of files) {
    const modState = await editorStateForFile(file)
    if (!modState) {
      out.push({ path: file, line: 1, label: 'mod' })
      continue
    }
    // If last segment might be an item in parent module
    const item = token.name
    const symbols = findSymbolInState(modState, item, file)
    if (symbols.length > 0) out.push(...symbols)
    else out.push({ path: file, line: 1, label: 'mod' })
  }
  return out
}

export function parseRustUsePath(
  line: string,
): { root: 'crate' | 'self' | 'super' | 'other'; parts: string[]; alias?: string } | null {
  const m = line.match(/^use\s+((?:crate|self|super)::)?([\w:]+)(?:\s+as\s+(\w+))?\s*;?/)
  if (!m) return null
  const rootPrefix = m[1]
  const path = m[2]!
  const alias = m[3]
  let root: 'crate' | 'self' | 'super' | 'other' = 'other'
  if (rootPrefix?.startsWith('crate')) root = 'crate'
  else if (rootPrefix?.startsWith('self')) root = 'self'
  else if (rootPrefix?.startsWith('super')) root = 'super'
  const parts = path.split('::').filter(Boolean)
  return { root, parts, alias }
}

async function resolveRustModFile(
  filePath: string,
  name: string,
  projectRoots: string[],
): Promise<string | null> {
  const dir = parentPath(filePath)
  return firstExistingFile([
    joinPath(dir, `${name}.rs`),
    joinPath(dir, name, 'mod.rs'),
    ...projectRoots.flatMap(root => [
      joinPath(root, 'src', `${name}.rs`),
      joinPath(root, 'src', name, 'mod.rs'),
    ]),
  ])
}

async function resolveRustPath(
  parts: string[],
  filePath: string,
  projectRoots: string[],
  root: 'crate' | 'self' | 'super' | 'other',
): Promise<string[]> {
  if (parts.length === 0) return []
  const crateRoots = await findRustSrcRoots(filePath, projectRoots)
  let bases: string[] = []
  if (root === 'crate') bases = crateRoots
  else if (root === 'self') bases = [parentPath(filePath)]
  else if (root === 'super') bases = [parentPath(parentPath(filePath))]
  else bases = [...crateRoots, parentPath(filePath)]

  const found: string[] = []
  for (const base of bases) {
    // parts → base/a/b.rs or base/a/b/mod.rs
    const fileCandidates = [
      joinPath(base, ...parts) + '.rs',
      joinPath(base, ...parts, 'mod.rs'),
    ]
    if (parts.length > 1) {
      fileCandidates.push(
        joinPath(base, ...parts.slice(0, -1)) + '.rs',
        joinPath(base, ...parts.slice(0, -1), 'mod.rs'),
      )
    }
    const hit = await firstExistingFile(fileCandidates)
    if (hit) found.push(hit)
  }
  return [...new Set(found)]
}

async function findRustSrcRoots(filePath: string, projectRoots: string[]): Promise<string[]> {
  const out: string[] = []
  for (const root of projectRoots) {
    const src = joinPath(root, 'src')
    out.push(src)
  }
  // Also treat ancestors that contain mod.rs / lib.rs / main.rs nearby
  for (const dir of ancestorDirs(filePath, projectRoots)) {
    const hit = await firstExistingFile([
      joinPath(dir, 'lib.rs'),
      joinPath(dir, 'main.rs'),
      joinPath(dir, 'mod.rs'),
    ])
    if (hit) out.push(dir)
  }
  return [...new Set(out.map(p => p.replace(/\\/g, '/')))]
}
