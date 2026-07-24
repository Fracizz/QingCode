import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { extractEditorSymbols } from '../editorSymbols'
import type { DefinitionTarget } from './types'

type SyntaxNodeLike = {
  type: { name: string }
  name: string
  from: number
  to: number
  parent: SyntaxNodeLike | null
  firstChild: SyntaxNodeLike | null
  nextSibling: SyntaxNodeLike | null
}

/**
 * Same-file definitions: outline symbols + assignment / import / param bindings.
 * Prefers innermost containing symbol, else nearest prior definition.
 */
export function resolveSameFile(
  state: EditorState,
  name: string,
  pos: number,
  filePath: string,
): DefinitionTarget[] {
  const symbols = extractEditorSymbols(state).filter(s => s.name === name)
  if (symbols.length > 0) {
    const containing = symbols
      .filter(s => s.from <= pos && pos <= s.to)
      .sort((a, b) => b.depth - a.depth || b.from - a.from)
    const pool = containing.length > 0 ? containing : [...symbols].sort((a, b) => a.from - b.from)
    const beforeOrAt = pool.filter(s => s.from <= pos)
    const ordered = beforeOrAt.length > 0 ? beforeOrAt : pool
    return ordered.map(s => ({
      path: filePath,
      line: s.line,
      from: s.from,
      label: s.kind,
    }))
  }

  return findVariableDefinitions(state, name, pos, filePath)
}

/**
 * Collect definition sites for `name` at or before `pos`:
 * - VariableDefinition / PropertyDefinition (JS/TS, …)
 * - AssignStatement LHS VariableName (Python / similar)
 * - ImportStatement imported names (Python: after `import`)
 * - Function/lambda parameters when typed as VariableDefinition or VariableName under ParamList
 */
export function findVariableDefinitions(
  state: EditorState,
  name: string,
  pos: number,
  filePath: string,
): DefinitionTarget[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 80) ?? syntaxTree(state)
  const hits: DefinitionTarget[] = []

  tree.iterate({
    enter(nodeRef) {
      const node = nodeRef.node as unknown as SyntaxNodeLike
      const typeName = node.type.name

      if (
        typeName === 'VariableDefinition' ||
        typeName === 'PropertyDefinition' ||
        typeName === 'Definition'
      ) {
        if (node.from > pos) return false
        pushIfName(state, node, name, filePath, hits, 'variable')
        return
      }

      if (typeName === 'AssignStatement' || typeName === 'AssignmentExpression') {
        if (node.from > pos) return false
        collectAssignmentTargets(state, node, name, filePath, hits, pos)
        return false // children walked manually for targets only
      }

      if (typeName === 'ImportStatement') {
        if (node.from > pos) return false
        collectImportBindings(state, node, name, filePath, hits, pos)
        return false
      }

      // Python / JS params: ParamList / FormalParameters contain VariableDefinition or VariableName
      if (
        typeName === 'ParamList' ||
        typeName === 'Parameters' ||
        typeName === 'FormalParameters' ||
        typeName === 'LambdaParameters'
      ) {
        if (node.from > pos) return false
        collectParamBindings(state, node, name, filePath, hits, pos)
        return false
      }
    },
  })

  if (hits.length === 0) return []
  hits.sort((a, b) => (b.from ?? 0) - (a.from ?? 0))
  return hits
}

function pushIfName(
  state: EditorState,
  node: SyntaxNodeLike,
  name: string,
  filePath: string,
  hits: DefinitionTarget[],
  label: string,
) {
  const text = state.doc.sliceString(node.from, node.to)
  if (text !== name) return
  const line = state.doc.lineAt(node.from)
  hits.push({
    path: filePath,
    line: line.number,
    from: node.from,
    column: node.from - line.from + 1,
    label,
  })
}

/** Names to the left of `=` / AssignOp in an assignment. */
function collectAssignmentTargets(
  state: EditorState,
  assignNode: SyntaxNodeLike,
  name: string,
  filePath: string,
  hits: DefinitionTarget[],
  pos: number,
) {
  let child = assignNode.firstChild
  while (child) {
    const t = child.type.name
    if (t === 'AssignOp' || t === '=' || t === ':' || t === 'TypeDef') break
    if (t === 'VariableName' || t === 'VariableDefinition' || t === 'PropertyDefinition') {
      if (child.from <= pos) pushIfName(state, child, name, filePath, hits, 'variable')
    }
    // Unpack: a, b = … — walk nested tuples/lists of names
    if (t === 'TupleExpression' || t === 'ListExpression' || t === 'PatternList') {
      collectNestedNames(state, child, name, filePath, hits, pos, 'variable')
    }
    child = child.nextSibling
  }
}

/** Python: imported names are VariableName nodes after the `import` keyword. */
function collectImportBindings(
  state: EditorState,
  importNode: SyntaxNodeLike,
  name: string,
  filePath: string,
  hits: DefinitionTarget[],
  pos: number,
) {
  let child = importNode.firstChild
  let afterImportKeyword = false
  while (child) {
    if (child.type.name === 'import' || state.doc.sliceString(child.from, child.to) === 'import') {
      afterImportKeyword = true
      child = child.nextSibling
      continue
    }
    if (afterImportKeyword) {
      if (child.type.name === 'VariableName' || child.type.name === 'VariableDefinition') {
        if (child.from <= pos) pushIfName(state, child, name, filePath, hits, 'variable')
      }
      // import a as b — alias is the local binding
      if (child.type.name === 'as' || state.doc.sliceString(child.from, child.to) === 'as') {
        const alias = child.nextSibling
        if (
          alias &&
          (alias.type.name === 'VariableName' || alias.type.name === 'VariableDefinition') &&
          alias.from <= pos
        ) {
          pushIfName(state, alias, name, filePath, hits, 'variable')
        }
      }
    }
    child = child.nextSibling
  }
}

function collectParamBindings(
  state: EditorState,
  paramsNode: SyntaxNodeLike,
  name: string,
  filePath: string,
  hits: DefinitionTarget[],
  pos: number,
) {
  collectNestedNames(state, paramsNode, name, filePath, hits, pos, 'variable')
}

function collectNestedNames(
  state: EditorState,
  root: SyntaxNodeLike,
  name: string,
  filePath: string,
  hits: DefinitionTarget[],
  pos: number,
  label: string,
) {
  let child = root.firstChild
  while (child) {
    const t = child.type.name
    if (
      (t === 'VariableName' || t === 'VariableDefinition' || t === 'PropertyDefinition') &&
      child.from <= pos
    ) {
      pushIfName(state, child, name, filePath, hits, label)
    }
    if (
      t === 'ParamList' ||
      t === 'TypedParam' ||
      t === 'DefaultParam' ||
      t === 'TupleExpression' ||
      t === 'PatternList'
    ) {
      collectNestedNames(state, child, name, filePath, hits, pos, label)
    }
    child = child.nextSibling
  }
}

/** Find a named symbol in an already-loaded EditorState (for cross-file). */
export function findSymbolInState(
  state: EditorState,
  name: string,
  filePath: string,
): DefinitionTarget[] {
  const symbols = extractEditorSymbols(state).filter(s => s.name === name)
  if (symbols.length > 0) {
    return symbols.map(s => ({
      path: filePath,
      line: s.line,
      from: s.from,
      label: s.kind,
    }))
  }
  return findVariableDefinitions(state, name, state.doc.length, filePath)
}
