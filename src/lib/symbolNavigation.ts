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
  findSemanticUsagesById,
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
const INITIAL_USAGE_PAGE_SIZE = 80

interface SemanticUsageTarget {
  symbolId: string
  name: string
  kind: string
}

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
  const usages = semantic.usages.map(usage => ({
    ...usage,
    score: usage.approximate ? 0 : 1000,
    callerName: usage.callerName ?? undefined,
    callerKind: usage.callerKind ?? undefined,
    usageKind: usage.usageKind ?? undefined,
  }))
  if (usages.length > 0 || !semantic.definition) {
    return usages
  }
  // Definition site is always a usage; surface it when the index found no call sites.
  return [
    {
      ...semantic.definition,
      score: 1000,
      callerName: semantic.definition.callerName ?? undefined,
      callerKind: semantic.definition.callerKind ?? undefined,
      usageKind: 'definition',
    },
  ]
}

function semanticUsageDetails(semantic: FindSemanticUsagesResponse, anchor?: DefinitionAnchor) {
  const candidates = semanticUsageCandidates(semantic)
  return {
    kind: semantic.kind ?? undefined,
    origin: semanticSymbolOrigin(semantic.definition?.relative),
    totalCount: Math.max(semantic.totalCount, candidates.length),
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
  anchor?: DefinitionAnchor,
  target?: SemanticUsageTarget
): Promise<void> {
  const identifier = identifierAt(state, position)
  const projects = useProjectStore.getState()
  if (!identifier && !target) {
    projects.pushToast('info', translate('请先将光标放在要查找的符号上'))
    return
  }
  const project = findProjectForPath(projects.projects, sourcePath) ?? projects.currentProject
  if (!project || !isTauri()) {
    projects.pushToast('info', translate('查找用法需要在桌面项目中使用'))
    return
  }

  const request = ++referenceRequest
  const symbolName = target?.name ?? identifier?.name ?? ''
  const pickerStore = useDefinitionPickerStore.getState()
  pickerStore.openPicker(symbolName, [], 'reference', {
    kind: target?.kind,
    totalCount: 0,
    complete: false,
    anchor,
    loading: true,
    requestId: request,
  })
  const isCurrentRequest = () => {
    const picker = useDefinitionPickerStore.getState()
    return request === referenceRequest && picker.open && picker.details?.requestId === request
  }
  const findSemanticPage = (query?: Parameters<typeof findSemanticUsages>[4]) =>
    target
      ? findSemanticUsagesById(project.path, target.symbolId, query)
      : findSemanticUsages(project.path, sourcePath, state, position, query)
  try {
    // Keep Shift+F12 responsive: render a useful first page immediately and
    // let the picker request the remaining usages on demand.
    const semantic = await findSemanticPage({
      offset: 0,
      maxResults: INITIAL_USAGE_PAGE_SIZE,
    }).catch(() => null)
    if (!isCurrentRequest()) return
    const candidates = semantic ? semanticUsageCandidates(semantic) : []
    if (semantic && candidates.length > 0) {
      const loadUsagePage = async (
        filter: SemanticUsageFilter,
        offset: number,
        maxResults: number
      ) => {
        try {
          const page = await findSemanticPage({
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
              symbol: semantic.name ?? symbolName,
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
          semantic.name ?? symbolName,
          candidates,
          'reference',
          semanticUsageDetails(semantic, anchor),
          loadUsagePage
        )
      return
    }
    if (semantic?.symbolId) {
      useDefinitionPickerStore.getState().closePicker()
      projects.pushToast(
        'info',
        translate('未找到「{symbol}」的用法', {
          symbol: semantic.name ?? symbolName,
        })
      )
      return
    }

    const response = await safeInvoke<NativeReferenceResponse>(
      '查找符号调用',
      'search_symbol_references',
      {
        root: project.path,
        symbol: symbolName,
        maxResults: 120,
        maxFiles: 8000,
      }
    )
    if (!isCurrentRequest()) return
    if (response.references.length === 0) {
      useDefinitionPickerStore.getState().closePicker()
      projects.pushToast('info', translate('未找到「{symbol}」的调用', { symbol: symbolName }))
      return
    }
    const nativeCandidates: DefinitionCandidate[] = response.references.map(reference => ({
      ...reference,
      score: 0,
      callerName: reference.callerName ?? undefined,
      callerKind: reference.callerKind ?? undefined,
      usageKind: reference.kind === 'call' ? 'call' : 'read',
    }))
    useDefinitionPickerStore.getState().openPicker(symbolName, nativeCandidates, 'reference', {
      kind: 'function',
      totalCount: nativeCandidates.length,
      truncated: response.truncated,
      complete: !response.truncated,
      filesIndexed: response.filesScanned,
      anchor,
    })
  } catch (error) {
    if (!isCurrentRequest()) return
    useDefinitionPickerStore.getState().closePicker()
    projects.pushToast(
      'error',
      translate('查找「{symbol}」调用失败', { symbol: symbolName }),
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
