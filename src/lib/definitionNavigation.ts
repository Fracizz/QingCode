import type { EditorState } from '@codemirror/state'
import { extractEditorSymbols } from './editorSymbols'
import { isTauri, safeInvoke } from './tauri'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { findProjectForPath, pathsEqual, projectRelativePath } from '../utils/fileReferences'
import { translate } from './i18n'
import {
  resolveSemanticSymbol,
  type SemanticConfidence,
  type SemanticUsageKind,
} from './semanticNavigation'

export interface IdentifierRange {
  name: string
  from: number
  to: number
}

export interface DefinitionAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

export interface DefinitionCandidate {
  name: string
  kind: string
  path: string
  relative: string
  line: number
  column: number
  text: string
  score: number
  callerName?: string
  callerKind?: string
  symbolId?: string
  confidence?: SemanticConfidence
  approximate?: boolean
  usageKind?: SemanticUsageKind
}

interface NativeDefinition {
  name: string
  kind: string
  path: string
  relative: string
  line: number
  column: number
  text: string
}

interface NativeDefinitionResponse {
  definitions: NativeDefinition[]
  filesScanned: number
  truncated: boolean
}

export type DefinitionContext = 'class' | 'call' | 'value'

const KEYWORDS = new Set([
  'as',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'def',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'fn',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'interface',
  'let',
  'match',
  'mod',
  'new',
  'null',
  'package',
  'pub',
  'return',
  'static',
  'struct',
  'super',
  'this',
  'trait',
  'true',
  'type',
  'undefined',
  'use',
  'var',
  'while',
])

let navigationRequest = 0

function isIdentifier(name: string): boolean {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name) && !KEYWORDS.has(name)
}

/** Resolve the language-aware CodeMirror word under a mouse position. */
export function identifierAt(state: EditorState, position: number): IdentifierRange | null {
  const safePosition = Math.max(0, Math.min(position, state.doc.length))
  const range =
    state.wordAt(safePosition) ?? (safePosition > 0 ? state.wordAt(safePosition - 1) : null)
  if (!range || safePosition < range.from || safePosition > range.to) return null
  const name = state.sliceDoc(range.from, range.to)
  return isIdentifier(name) ? { name, from: range.from, to: range.to } : null
}

export function definitionContextAt(
  state: EditorState,
  identifier: IdentifierRange
): DefinitionContext {
  const before = state.sliceDoc(Math.max(0, identifier.from - 24), identifier.from)
  const after = state.sliceDoc(identifier.to, Math.min(state.doc.length, identifier.to + 8))
  if (/\bnew\s*$/u.test(before)) return 'class'
  if (/^\s*\(/u.test(after)) return 'call'
  return 'value'
}

function kindScore(kind: string, context: DefinitionContext): number {
  const normalized = kind.toLowerCase()
  if (context === 'class') {
    return /(class|struct|enum|interface|type|trait)/u.test(normalized) ? 320 : 0
  }
  if (context === 'call') {
    return /(function|method|constructor|macro)/u.test(normalized) ? 260 : 0
  }
  return /(variable|constant|field|module)/u.test(normalized) ? 80 : 0
}

function directoryOf(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')))
}

function withoutSourceExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/iu, '')
}

function normalizeJoinedPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  const prefix = normalized.match(/^[A-Za-z]:/u)?.[0] ?? (normalized.startsWith('/') ? '/' : '')
  const parts = normalized.slice(prefix.length).split('/').filter(Boolean)
  const output: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') output.pop()
    else output.push(part)
  }
  return `${prefix}${prefix === '/' ? '' : '/'}${output.join('/')}`
}

/** Best-effort JS/TS relative import target for a clicked binding. */
export function relativeImportTarget(
  state: EditorState,
  sourcePath: string,
  symbol: string
): string | null {
  const imports = /import\s+([\s\S]{0,300}?)\s+from\s+['"]([^'"]+)['"]/gu
  const symbolPattern = new RegExp(`(^|\\W)${symbol.replace(/[$]/gu, '\\$&')}(\\W|$)`, 'u')
  for (const match of state.doc.toString().matchAll(imports)) {
    const bindings = match[1]
    const specifier = match[2]
    if (!symbolPattern.test(bindings) || !specifier.startsWith('.')) continue
    return withoutSourceExtension(
      normalizeJoinedPath(`${directoryOf(sourcePath)}/${specifier}`)
    ).toLocaleLowerCase()
  }
  return null
}

export function rankDefinitionCandidates(
  candidates: DefinitionCandidate[],
  sourcePath: string,
  context: DefinitionContext,
  importTarget: string | null = null
): DefinitionCandidate[] {
  const sourceDirectory = directoryOf(sourcePath).toLocaleLowerCase()
  return candidates
    .map(candidate => {
      let score = candidate.score + kindScore(candidate.kind, context)
      if (pathsEqual(candidate.path, sourcePath)) score += 1000
      else if (directoryOf(candidate.path).toLocaleLowerCase() === sourceDirectory) score += 220
      if (importTarget) {
        const candidateModule = withoutSourceExtension(
          normalizeJoinedPath(candidate.path)
        ).toLocaleLowerCase()
        if (candidateModule === importTarget || candidateModule === `${importTarget}/index`) {
          score += 700
        }
      }
      if (/[/\\](?:test|tests|__tests__|fixtures)[/\\]/iu.test(candidate.path)) score -= 90
      return { ...candidate, score }
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.relative.localeCompare(right.relative) ||
        left.line - right.line
    )
}

function deduplicate(candidates: DefinitionCandidate[]): DefinitionCandidate[] {
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    const key = `${candidate.path.replace(/\\/gu, '/').toLocaleLowerCase()}:${candidate.line}:${
      candidate.column
    }`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function jumpToDefinitionCandidate(candidate: DefinitionCandidate): Promise<void> {
  await useEditorStore.getState().openFile(candidate.path, candidate.line, candidate.column)
}

function showCandidates(symbol: string, candidates: DefinitionCandidate[]) {
  if (candidates.length === 1) {
    void jumpToDefinitionCandidate(candidates[0])
    return
  }
  useDefinitionPickerStore.getState().openPicker(symbol, candidates)
}

function currentFileCandidates(
  state: EditorState,
  path: string,
  symbol: string,
  relative: string
): DefinitionCandidate[] {
  return extractEditorSymbols(state, 30)
    .filter(candidate => candidate.name === symbol)
    .map(candidate => {
      const line = state.doc.lineAt(candidate.from)
      return {
        name: candidate.name,
        kind: candidate.kind,
        path,
        relative,
        line: line.number,
        column: candidate.from - line.from + 1,
        text: line.text.trim(),
        score: 500,
      }
    })
}

/**
 * Resolve definition candidates without changing editor state.
 *
 * Ctrl-hover previews and Ctrl+click navigation share this path so they cannot
 * drift into two different resolution behaviours.
 */
export async function resolveDefinitionCandidates(
  state: EditorState,
  sourcePath: string,
  identifier: IdentifierRange
): Promise<DefinitionCandidate[]> {
  const projectState = useProjectStore.getState()
  const project =
    findProjectForPath(projectState.projects, sourcePath) ?? projectState.currentProject
  const relative = project ? projectRelativePath(project.path, sourcePath) : sourcePath
  const context = definitionContextAt(state, identifier)
  const importTarget = relativeImportTarget(state, sourcePath, identifier.name)
  const local = currentFileCandidates(state, sourcePath, identifier.name, relative)
  const localAwayFromClick = local.filter(
    candidate =>
      candidate.line !== state.doc.lineAt(identifier.from).number ||
      candidate.column !== identifier.from - state.doc.lineAt(identifier.from).from + 1
  )

  // Prefer scope-bound semantic resolution. The older same-name search remains
  // below as a compatibility fallback for unsupported syntax/languages.
  if (project && isTauri()) {
    try {
      const semantic = await resolveSemanticSymbol(project.path, sourcePath, state, identifier.from)
      if (semantic.definitions.length > 0) {
        const candidates = semantic.definitions.map((candidate): DefinitionCandidate => ({
          ...candidate,
          score: candidate.approximate ? 400 : 2400,
          callerName: candidate.callerName ?? undefined,
          callerKind: candidate.callerKind ?? undefined,
          usageKind: candidate.usageKind ?? undefined,
        }))
        return rankDefinitionCandidates(candidates, sourcePath, context, importTarget)
      }
    } catch {
      // Keep the established heuristic path available when the semantic index
      // is unavailable or a grammar cannot resolve the cursor.
    }
  }

  // A unique declaration in the same file is the cheapest fallback.
  if (localAwayFromClick.length === 1) {
    return rankDefinitionCandidates(localAwayFromClick, sourcePath, context, importTarget)
  }

  if (!project || !isTauri()) {
    return rankDefinitionCandidates(local, sourcePath, context, importTarget)
  }

  try {
    const response = await safeInvoke<NativeDefinitionResponse>(
      '查找符号定义',
      'search_symbol_definitions',
      {
        root: project.path,
        symbol: identifier.name,
        maxResults: 80,
        maxFiles: 8000,
      }
    )
    const native = response.definitions.map((candidate): DefinitionCandidate => ({
      ...candidate,
      score: 0,
    }))
    const ranked = rankDefinitionCandidates(
      deduplicate([...local, ...native]),
      sourcePath,
      context,
      importTarget
    )
    return ranked
  } catch (error) {
    const ranked = rankDefinitionCandidates(local, sourcePath, context, importTarget)
    if (ranked.length > 0) return ranked
    throw error
  }
}

/** Main Ctrl+click entry point. */
export async function goToDefinition(
  state: EditorState,
  sourcePath: string,
  identifier: IdentifierRange
): Promise<void> {
  const request = ++navigationRequest
  try {
    const candidates = await resolveDefinitionCandidates(state, sourcePath, identifier)
    if (request !== navigationRequest) return
    if (candidates.length === 0) {
      useProjectStore
        .getState()
        .pushToast('info', translate('未找到「{symbol}」的定义', { symbol: identifier.name }))
      return
    }
    showCandidates(identifier.name, candidates)
  } catch (error) {
    if (request !== navigationRequest) return
    useProjectStore
      .getState()
      .pushToast(
        'error',
        translate('查找「{symbol}」定义失败', { symbol: identifier.name }),
        String(error)
      )
  }
}
