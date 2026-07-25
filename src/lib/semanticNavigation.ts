import type { EditorState } from '@codemirror/state'
import { getLiveEditorContent } from './editorSession'
import { isTauri, safeInvoke } from './tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { findProjectForPath } from '../utils/fileReferences'

export type SemanticConfidence = 'bound' | 'indexed' | 'approximate'
export type SemanticUsageKind =
  | 'call'
  | 'member-call'
  | 'read'
  | 'member-read'
  | 'write'
  | 'member-write'
  | 'read-write'
  | 'member-read-write'
  | 'type'
  | 'import'

export type SemanticUsageFilter = 'all' | 'read' | 'write' | 'call' | 'import' | 'approximate'

export interface SemanticUsageQuery {
  filter?: SemanticUsageFilter
  offset?: number
  maxResults?: number
}

export function semanticUsageQueryInput(query: SemanticUsageQuery = {}) {
  const usageKinds: Partial<Record<SemanticUsageFilter, SemanticUsageKind[]>> = {
    read: ['read', 'member-read'],
    write: ['write', 'member-write', 'read-write', 'member-read-write'],
    call: ['call', 'member-call'],
    import: ['import'],
  }
  return {
    offset: query.offset ?? 0,
    maxResults: query.maxResults ?? 200,
    usageKinds: usageKinds[query.filter ?? 'all'],
    approximateOnly: query.filter === 'approximate',
  }
}

export interface SemanticCandidate {
  symbolId: string
  name: string
  kind: string
  path: string
  relative: string
  line: number
  column: number
  text: string
  confidence: SemanticConfidence
  approximate: boolean
  usageKind: SemanticUsageKind | null
  callerName: string | null
  callerKind: string | null
}

export interface ResolveSemanticSymbolResponse {
  symbolId: string | null
  name: string | null
  kind: string | null
  definitions: SemanticCandidate[]
  filesIndexed: number
  complete: boolean
  truncated: boolean
}

export interface FindSemanticUsagesResponse {
  symbolId: string | null
  name: string | null
  kind: string | null
  definition: SemanticCandidate | null
  usages: SemanticCandidate[]
  totalCount: number
  filesIndexed: number
  complete: boolean
  truncated: boolean
}

export interface IndexedWorkspaceSymbolsResponse {
  definitions: SemanticCandidate[]
  filesIndexed: number
  available: boolean
  complete: boolean
  truncated: boolean
}

export interface SemanticIndexStatus {
  root: string
  filesIndexed: number
  complete: boolean
  truncated: boolean
}

// Keep revisions monotonic across WebView hot reloads/reloads while the Rust
// process and its overlays remain alive. A counter starting at zero can make
// every new edit look stale after a frontend reload.
let overlayRevision = Date.now() * 1000
const overlayTimers = new Map<string, number>()

export function nextSemanticRevision(): number {
  overlayRevision += 1
  return overlayRevision
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export function utf8ByteOffsetAt(state: EditorState, position: number): number {
  const safePosition = Math.max(0, Math.min(position, state.doc.length))
  return new TextEncoder().encode(state.sliceDoc(0, safePosition)).length
}

function projectRootForPath(path: string): string | null {
  const projects = useProjectStore.getState()
  return findProjectForPath(projects.projects, path)?.path ?? projects.currentProject?.path ?? null
}

export async function prepareSemanticIndex(root: string): Promise<SemanticIndexStatus | null> {
  if (!isTauri()) return null
  return safeInvoke<SemanticIndexStatus>('准备代码导航索引', 'prepare_semantic_index', {
    root,
    maxFiles: 8000,
  })
}

export async function updateSemanticOverlay(
  root: string,
  path: string,
  content: string
): Promise<boolean> {
  if (!isTauri()) return false
  const revision = nextSemanticRevision()
  return safeInvoke<boolean>('更新代码导航缓冲区', 'update_semantic_overlay', {
    root,
    path,
    content,
    revision,
  })
}

export function scheduleSemanticOverlay(path: string, state: EditorState): void {
  if (!isTauri()) return
  const root = projectRootForPath(path)
  if (!root) return
  const key = normalizedPath(path)
  const existing = overlayTimers.get(key)
  if (existing) window.clearTimeout(existing)
  overlayTimers.set(
    key,
    window.setTimeout(() => {
      overlayTimers.delete(key)
      void updateSemanticOverlay(root, path, state.doc.toString()).catch(error => {
        console.error('semantic overlay update failed:', error)
      })
    }, 300)
  )
}

export async function syncDirtySemanticOverlay(path: string): Promise<void> {
  const editor = useEditorStore.getState()
  const tab =
    editor.tabs.find(candidate => candidate.path === path) ??
    Object.values(editor.projectSessions)
      .flatMap(session => session.tabs)
      .find(candidate => candidate.path === path)
  if (!tab?.dirty) return
  const content = getLiveEditorContent(tab.id) ?? tab.content
  const root = projectRootForPath(path)
  if (!root || content == null) return
  await updateSemanticOverlay(root, path, content)
}

export async function clearSemanticOverlay(path: string): Promise<void> {
  const key = normalizedPath(path)
  const timer = overlayTimers.get(key)
  if (timer) window.clearTimeout(timer)
  overlayTimers.delete(key)
  if (!isTauri()) return
  await safeInvoke('清除代码导航缓冲区', 'clear_semantic_overlay', { path })
}

function semanticRequestInput(root: string, path: string, state: EditorState, position: number) {
  return {
    root,
    path,
    position: utf8ByteOffsetAt(state, position),
    content: state.doc.toString(),
    revision: nextSemanticRevision(),
  }
}

export async function resolveSemanticSymbol(
  root: string,
  path: string,
  state: EditorState,
  position: number
): Promise<ResolveSemanticSymbolResponse> {
  return safeInvoke<ResolveSemanticSymbolResponse>('解析光标符号', 'resolve_symbol_at', {
    ...semanticRequestInput(root, path, state, position),
    maxResults: 80,
  })
}

export async function findSemanticUsages(
  root: string,
  path: string,
  state: EditorState,
  position: number,
  query: SemanticUsageQuery = {}
): Promise<FindSemanticUsagesResponse> {
  return safeInvoke<FindSemanticUsagesResponse>('查找符号用法', 'find_symbol_usages_at', {
    ...semanticRequestInput(root, path, state, position),
    ...semanticUsageQueryInput(query),
  })
}

export async function searchIndexedWorkspaceSymbols(
  root: string,
  query: string
): Promise<IndexedWorkspaceSymbolsResponse> {
  return safeInvoke<IndexedWorkspaceSymbolsResponse>(
    '搜索代码导航索引',
    'search_indexed_workspace_symbols',
    {
      root,
      query,
      maxResults: 100,
    }
  )
}
