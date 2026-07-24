import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export type EditorSymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'heading'
  | 'selector'

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
  'FunctionItem',
  'FunctionDecl',
  'MethodDeclaration',
  'ArrowFunction',
  'StructItem',
  'EnumItem',
  'TraitItem',
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

      if (
        typeName === 'FunctionDeclaration' ||
        typeName === 'FunctionExpression' ||
        typeName === 'FunctionItem' ||
        typeName === 'FunctionDecl'
      ) {
        const nameNode = firstChildNamed(
          node,
          'VariableDefinition',
          'VariableName',
          'BoundIdentifier',
          'DefName'
        )
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
          'Definition',
          'DefName',
          'BoundIdentifier',
        )
        pushSymbol(out, state, 'method', nameNode, node.from, node.to, depth)
        depth += 1
        return
      }

      if (typeName === 'ClassDeclaration' || typeName === 'ClassDefinition') {
        const nameNode = firstChildNamed(
          node,
          'VariableDefinition',
          'VariableName',
          'Definition'
        )
        pushSymbol(out, state, 'class', nameNode, node.from, node.to, depth)
        depth += 1
        return
      }

      if (typeName === 'StructItem' || typeName === 'EnumItem') {
        const nameNode = node.getChild('TypeIdentifier')
        pushSymbol(
          out,
          state,
          typeName === 'EnumItem' ? 'enum' : 'class',
          nameNode,
          node.from,
          node.to,
          depth
        )
        depth += 1
        return
      }

      if (typeName === 'TraitItem') {
        pushSymbol(
          out,
          state,
          'interface',
          node.getChild('TypeIdentifier'),
          node.from,
          node.to,
          depth
        )
        depth += 1
        return
      }

      if (typeName === 'TypeItem') {
        pushSymbol(
          out,
          state,
          'type',
          node.getChild('TypeIdentifier'),
          node.from,
          node.to,
          depth
        )
        return
      }

      if (
        typeName === 'InterfaceDeclaration' ||
        typeName === 'TypeAliasDeclaration' ||
        typeName === 'EnumDeclaration'
      ) {
        const kind: EditorSymbolKind =
          typeName === 'InterfaceDeclaration'
            ? 'interface'
            : typeName === 'EnumDeclaration'
              ? 'enum'
              : 'type'
        const nameNode = firstChildNamed(
          node,
          'TypeDefinition',
          'TypeName',
          'VariableDefinition',
          'Definition'
        )
        pushSymbol(out, state, kind, nameNode, node.from, node.to, depth)
        return
      }

      if (typeName === 'TypeSpec') {
        const kind: EditorSymbolKind = node.getChild('StructType')
          ? 'class'
          : node.getChild('InterfaceType')
            ? 'interface'
            : 'type'
        pushSymbol(out, state, kind, node.getChild('DefName'), node.from, node.to, depth)
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

      if (typeName === 'VariableDefinition') {
        const parentName = node.parent?.name
        if (
          parentName === 'VariableDeclaration' &&
          !node.parent?.getChild('ArrowFunction') &&
          !node.parent?.getChild('FunctionExpression')
        ) {
          pushSymbol(out, state, 'variable', node, node.from, node.to, depth)
        } else if (parentName === 'ParamList') {
          pushSymbol(out, state, 'variable', node, node.from, node.to, depth)
        }
        return
      }

      if (typeName === 'VariableName') {
        const parent = node.parent
        if (
          parent?.name === 'AssignStatement' &&
          parent.getChild('VariableName')?.from === node.from
        ) {
          pushSymbol(out, state, 'variable', node, node.from, node.to, depth)
        } else if (parent?.name === 'ParamList') {
          pushSymbol(out, state, 'variable', node, node.from, node.to, depth)
        }
        return
      }

      if (typeName === 'BoundIdentifier') {
        const parentName = node.parent?.name
        if (parentName === 'ConstItem' || parentName === 'StaticItem') {
          pushSymbol(out, state, 'constant', node, node.from, node.to, depth)
        } else if (parentName === 'LetDeclaration' || parentName === 'Parameter') {
          pushSymbol(out, state, 'variable', node, node.from, node.to, depth)
        }
        return
      }

      if (typeName === 'Definition') {
        const parentName = node.parent?.name
        if (parentName === 'VariableDeclarator' || parentName === 'FormalParameter') {
          pushSymbol(out, state, 'variable', node, node.from, node.to, depth)
        }
        return
      }

      if (typeName === 'DefName') {
        const parentName = node.parent?.name
        if (parentName === 'ConstSpec') {
          pushSymbol(out, state, 'constant', node, node.from, node.to, depth)
        } else if (parentName === 'VarDecl' || parentName === 'Parameter') {
          pushSymbol(out, state, 'variable', node, node.from, node.to, depth)
        }
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
    case 'interface':
      return '接口'
    case 'type':
      return '类型'
    case 'enum':
      return '枚举'
    case 'variable':
      return '变量'
    case 'constant':
      return '常量'
    case 'heading':
      return '标题'
    case 'selector':
      return '选择器'
  }
}
