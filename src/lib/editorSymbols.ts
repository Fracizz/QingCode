import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export type EditorSymbolKind = 'function' | 'class' | 'method' | 'heading' | 'selector'

/** Minimal Lezer node shape used by the extractor (avoids depending on @lezer/common types). */
type SyntaxNodeLike = {
  name: string
  type: { name: string }
  from: number
  to: number
  parent: SyntaxNodeLike | null
  getChild(name: string): SyntaxNodeLike | null
}

export type EditorSymbol = {
  name: string
  kind: EditorSymbolKind
  from: number
  to: number
  line: number
  /** Nesting depth for outline indentation (0 = top-level). */
  depth: number
}

const MAX_SYMBOLS = 2000

/** Nodes that increase nesting depth while their body is walked. */
const DEPTH_NODES = new Set([
  'ClassDeclaration',
  'ClassDefinition',
  'FunctionDeclaration',
  'FunctionDefinition',
  'FunctionExpression',
  'MethodDeclaration',
  'ArrowFunction',
])

function firstChildNamed(node: SyntaxNodeLike, ...names: string[]): SyntaxNodeLike | null {
  for (const name of names) {
    const child = node.getChild(name)
    if (child) return child
  }
  return null
}

function textAt(state: EditorState, node: SyntaxNodeLike): string {
  return state.doc.sliceString(node.from, node.to)
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

function headingName(state: EditorState, node: SyntaxNodeLike): string {
  return cleanName(textAt(state, node).replace(/^#{1,6}\s*/, ''))
}

function selectorName(state: EditorState, node: SyntaxNodeLike): string {
  const block = node.getChild('Block')
  const end = block ? block.from : Math.min(node.to, node.from + 80)
  return cleanName(state.doc.sliceString(node.from, end))
}

function pushSymbol(
  out: EditorSymbol[],
  state: EditorState,
  kind: EditorSymbolKind,
  nameNode: SyntaxNodeLike | null,
  fallbackFrom: number,
  fallbackTo: number,
  depth: number,
  nameOverride?: string,
) {
  const name = nameOverride ?? (nameNode ? cleanName(textAt(state, nameNode)) : '')
  if (!name) return
  const from = nameNode?.from ?? fallbackFrom
  const to = nameNode?.to ?? fallbackTo
  out.push({
    name,
    kind,
    from,
    to,
    line: state.doc.lineAt(from).number,
    depth: Math.max(0, depth),
  })
}

/**
 * Best-effort symbol outline from the CodeMirror / Lezer syntax tree.
 * Returns [] when no language pack is loaded or the tree has no known symbols.
 */
export function extractEditorSymbols(state: EditorState, parseTimeoutMs = 50): EditorSymbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, parseTimeoutMs) ?? syntaxTree(state)

  const out: EditorSymbol[] = []
  let depth = 0

  tree.iterate({
    enter(nodeRef) {
      if (out.length >= MAX_SYMBOLS) return false
      const node = nodeRef.node as unknown as SyntaxNodeLike
      const typeName = node.type.name

      if (typeName === 'FunctionDeclaration' || typeName === 'FunctionExpression') {
        const nameNode = firstChildNamed(node, 'VariableDefinition', 'VariableName')
        pushSymbol(out, state, 'function', nameNode, node.from, node.to, depth)
        depth += 1
        return
      }

      if (typeName === 'FunctionDefinition') {
        const nameNode = firstChildNamed(node, 'VariableName', 'VariableDefinition')
        pushSymbol(out, state, 'function', nameNode, node.from, node.to, depth)
        depth += 1
        return
      }

      if (typeName === 'MethodDeclaration') {
        const nameNode = firstChildNamed(
          node,
          'PropertyDefinition',
          'VariableDefinition',
          'VariableName',
        )
        pushSymbol(out, state, 'method', nameNode, node.from, node.to, depth)
        depth += 1
        return
      }

      if (typeName === 'ClassDeclaration' || typeName === 'ClassDefinition') {
        const nameNode = firstChildNamed(node, 'VariableDefinition', 'VariableName')
        pushSymbol(out, state, 'class', nameNode, node.from, node.to, depth)
        depth += 1
        return
      }

      if (typeName === 'ArrowFunction') {
        const parent = node.parent
        if (parent?.name === 'VariableDeclaration' || parent?.name === 'AssignmentExpression') {
          const nameNode =
            parent.getChild('VariableDefinition') ?? parent.getChild('VariableName') ?? null
          if (nameNode) {
            pushSymbol(out, state, 'function', nameNode, nameNode.from, nameNode.to, depth)
          }
        }
        depth += 1
        return
      }

      if (
        /^ATXHeading[1-6]$/.test(typeName) ||
        typeName === 'SetextHeading1' ||
        typeName === 'SetextHeading2'
      ) {
        const levelMatch = typeName.match(/([1-6])$/)
        const headingDepth = levelMatch ? Number(levelMatch[1]) - 1 : 0
        const name = headingName(state, node)
        if (name) {
          out.push({
            name,
            kind: 'heading',
            from: node.from,
            to: node.to,
            line: state.doc.lineAt(node.from).number,
            depth: headingDepth,
          })
        }
        return false
      }

      if (typeName === 'RuleSet') {
        const name = selectorName(state, node)
        if (name) {
          out.push({
            name,
            kind: 'selector',
            from: node.from,
            to: node.to,
            line: state.doc.lineAt(node.from).number,
            depth,
          })
        }
        return false
      }
    },
    leave(nodeRef) {
      if (DEPTH_NODES.has(nodeRef.node.type.name)) {
        depth = Math.max(0, depth - 1)
      }
    },
  })

  return out
}

/** Human-readable kind label (Chinese source / i18n key). */
export function editorSymbolKindLabel(kind: EditorSymbolKind): string {
  switch (kind) {
    case 'function':
      return '函数'
    case 'class':
      return '类'
    case 'method':
      return '方法'
    case 'heading':
      return '标题'
    case 'selector':
      return '选择器'
  }
}
