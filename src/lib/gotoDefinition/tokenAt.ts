import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { IdentifierToken } from './types'

/** Lezer node names that usually carry a jumpable identifier. */
const IDENT_NODES = new Set([
  'VariableName',
  'VariableDefinition',
  'PropertyName',
  'PropertyDefinition',
  'TypeName',
  'NamespaceName',
  'Identifier',
  'AttributeName',
  'Definition',
])

const SKIP_NODES = new Set([
  'String',
  'StringLiteral',
  'Number',
  'LineComment',
  'BlockComment',
  'Comment',
  'BooleanLiteral',
  'null',
  'None',
])

function isIdentLike(name: string): boolean {
  if (SKIP_NODES.has(name)) return false
  if (IDENT_NODES.has(name)) return true
  // Language packs sometimes use *Name / *Definition suffixes.
  return /(?:Name|Definition|Identifier)$/.test(name) && name !== 'Document'
}

/**
 * Best-effort identifier under `pos` (or immediately before when on a boundary).
 */
export function identifierAt(state: EditorState, pos: number): IdentifierToken | null {
  const docLen = state.doc.length
  const clamped = Math.max(0, Math.min(pos, docLen))
  const tree = syntaxTree(state)

  const candidates = [clamped, Math.max(0, clamped - 1)]
  for (const p of candidates) {
    let node: { type: { name: string }; from: number; to: number; parent: typeof node | null } | null =
      tree.resolveInner(p, 1)
    for (let depth = 0; node && depth < 8; depth++) {
      const typeName = node.type.name
      if (isIdentLike(typeName)) {
        const name = state.doc.sliceString(node.from, node.to)
        if (isValidIdentifier(name)) {
          return { name, from: node.from, to: node.to }
        }
      }
      node = node.parent
    }
  }

  // Fallback: word under cursor when no language tree (or unknown node).
  return wordAt(state, clamped)
}

function isValidIdentifier(name: string): boolean {
  if (!name || name.length > 200) return false
  // Allow unicode identifiers used in Python / JS.
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)
}

function wordAt(state: EditorState, pos: number): IdentifierToken | null {
  const line = state.doc.lineAt(pos)
  const text = line.text
  let offset = pos - line.from
  if (offset > 0 && offset === text.length) offset -= 1
  if (offset < 0 || offset >= text.length) return null
  if (!/[\p{L}\p{N}_$]/u.test(text[offset]!)) return null

  let start = offset
  let end = offset + 1
  while (start > 0 && /[\p{L}\p{N}_$]/u.test(text[start - 1]!)) start -= 1
  while (end < text.length && /[\p{L}\p{N}_$]/u.test(text[end]!)) end += 1
  const name = text.slice(start, end)
  if (!isValidIdentifier(name)) return null
  return { name, from: line.from + start, to: line.from + end }
}
