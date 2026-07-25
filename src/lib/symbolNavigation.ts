import type { EditorState } from '@codemirror/state'
import { getEditorView } from './editorSession'
import {
  identifierAt,
  type DefinitionAnchor,
  type DefinitionCandidate,
} from './definitionNavigation'
import { isTauri, safeInvoke } from './tauri'
import { translate } from './i18n'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { findProjectForPath } from '../utils/fileReferences'
import {
  findSemanticUsages,
  searchIndexedWorkspaceSymbols,
  type FindSemanticUsagesResponse,
  type SemanticUsageFilter,
} from './semanticNavigation'

export interface WorkspaceSymbolCandidate {
  name: string
  kind: string
  path: string
  relative: string
  line: number
  column: number
  text: string
  symbolId?: string
  confidence?: 'bound' | 'indexed' | 'approximate'
  approximate?: boolean
}

interface NativeReference extends WorkspaceSymbolCandidate {
  callerName: string | null
  callerKind: string | null
}

interface NativeReferenceResponse {
  references: NativeReference[]
  filesScanned: number
  truncated: boolean
}

interface NativeWorkspaceSymbolResponse {
  definitions: WorkspaceSymbolCandidate[]
  filesScanned: number
  truncated: boolean
}

export interface WorkspaceSymbolSearchResult {
  definitions: WorkspaceSymbolCandidate[]
  filesIndexed: number
  complete: boolean
  truncated: boolean
}

let referenceRequest = 0

function semanticSymbolOrigin(relative: string | undefined): string | undefined {
  if (!relative) return undefined
  const normalized = relative.replace(/\\/gu, '/')
  if (normalized.toLowerCase().endsWith('.py')) {
    const parts = normalized.slice(0, -3).split('/')
    if (
      parts.length > 1 &&
      ['api', 'app', 'backend', 'server', 'src'].includes(parts[0].toLowerCase())
    ) {
      parts.shift()
    }
    return parts.join('.')
  }
  return normalized
}

function semanticUsageCandidates(semantic: FindSemanticUsagesResponse): DefinitionCandidate[] {
  return semantic.usages.map(usage => ({
    ...usage,
    score: usage.approximate ? 0 : 1000,
    callerName: usage.callerName ?? undefined,
    callerKind: usage.callerKind ?? undefined,
    usageKind: usage.usageKind ?? undefined,
  }))
}

function semanticUsageDetails(semantic: FindSemanticUsagesResponse, anchor?: DefinitionAnchor) {
  return {
    kind: semantic.kind ?? undefined,
    origin: semanticSymbolOrigin(semantic.definition?.relative),
    totalCount: semantic.totalCount,
    filesIndexed: semantic.filesIndexed,
    complete: semantic.complete,
    truncated: semantic.truncated,
    anchor,
  }
}

export async function findUsagesAtEditor(
  sourcePath: string,
  state: EditorState,
  position: number,
  anchor?: DefinitionAnchor
): Promise<void> {
  const identifier = identifierAt(state, position)
  const projects = useProjectStore.getState()
  if (!identifier) {
    projects.pushToast('info', translate('请先将光标放在要查找的符号上'))
    return
  }
  const project = findProjectForPath(projects.projects, sourcePath) ?? projects.currentProject
  if (!project || !isTauri()) {
    projects.pushToast('info', translate('查找用法需要在桌面项目中使用'))
    return
  }

  const request = ++referenceRequest
  try {
    const semantic = await findSemanticUsages(project.path, sourcePath, state, position).catch(
      () => null
    )
    if (request !== referenceRequest) return
    if (semantic && semantic.usages.length > 0) {
      const candidates = semanticUsageCandidates(semantic)
      const loadUsagePage = async (
        filter: SemanticUsageFilter,
        offset: number,
        maxResults: number
      ) => {
        try {
          const page = await findSemanticUsages(project.path, sourcePath, state, position, {
            filter,
            offset,
            maxResults,
          })
          return {
            candidates: semanticUsageCandidates(page),
            details: semanticUsageDetails(page, anchor),
          }
        } catch (error) {
          projects.pushToast(
            'error',
            translate('查找「{symbol}」用法失败', {
              symbol: semantic.name ?? identifier.name,
            }),
            String(error)
          )
          return {
            candidates: [],
            details: {
              ...semanticUsageDetails(semantic, anchor),
              totalCount: 0,
              truncated: false,
            },
          }
        }
      }
      useDefinitionPickerStore
        .getState()
        .openPicker(
          semantic.name ?? identifier.name,
          candidates,
          'reference',
          semanticUsageDetails(semantic, anchor),
          loadUsagePage
        )
      return
    }
    if (semantic?.symbolId) {
      projects.pushToast(
        'info',
        translate('未找到「{symbol}」的用法', {
          symbol: semantic.name ?? identifier.name,
        })
      )
      return
    }

    const response = await safeInvoke<NativeReferenceResponse>(
      '查找符号调用',
      'search_symbol_references',
      {
        root: project.path,
        symbol: identifier.name,
        maxResults: 120,
        maxFiles: 8000,
      }
    )
    if (request !== referenceRequest) return
    if (response.references.length === 0) {
      projects.pushToast('info', translate('未找到「{symbol}」的调用', { symbol: identifier.name }))
      return
    }
    const candidates: DefinitionCandidate[] = response.references.map(reference => ({
      ...reference,
      score: 0,
      callerName: reference.callerName ?? undefined,
      callerKind: reference.callerKind ?? undefined,
      usageKind: reference.kind === 'call' ? 'call' : 'read',
    }))
    useDefinitionPickerStore.getState().openPicker(identifier.name, candidates, 'reference', {
      kind: 'function',
      totalCount: candidates.length,
      truncated: response.truncated,
      complete: !response.truncated,
      filesIndexed: response.filesScanned,
      anchor,
    })
  } catch (error) {
    if (request !== referenceRequest) return
    projects.pushToast(
      'error',
      translate('查找「{symbol}」调用失败', { symbol: identifier.name }),
      String(error)
    )
  }
}

export async function searchWorkspaceSymbols(
  root: string,
  query: string
): Promise<WorkspaceSymbolSearchResult> {
  if (!isTauri()) {
    return { definitions: [], filesIndexed: 0, complete: false, truncated: false }
  }
  const indexed = await searchIndexedWorkspaceSymbols(root, query).catch(() => null)
  if (indexed?.available) {
    return indexed
  }
  const response = await safeInvoke<NativeWorkspaceSymbolResponse>(
    '搜索工作区符号',
    'search_workspace_symbols',
    {
      root,
      query,
      maxResults: 100,
      maxFiles: 8000,
    }
  )
  return {
    definitions: response.definitions,
    filesIndexed: response.filesScanned,
    complete: !response.truncated,
    truncated: response.truncated,
  }
}

export async function findUsagesAtActiveEditor(): Promise<void> {
  const editor = useEditorStore.getState()
  const activeTab = editor.tabs.find(tab => tab.id === editor.activeTabId)
  const view = activeTab ? getEditorView(activeTab.id) : undefined
  if (!activeTab || !view) {
    useProjectStore.getState().pushToast('info', translate('请先将光标放在要查找的符号上'))
    return
  }
  const position = view.state.selection.main.head
  const coords = view.coordsAtPos(position)
  const anchor = coords
    ? {
        left: coords.left,
        top: coords.top,
        right: coords.right,
        bottom: coords.bottom,
      }
    : undefined
  await findUsagesAtEditor(activeTab.path, view.state, position, anchor)
}
