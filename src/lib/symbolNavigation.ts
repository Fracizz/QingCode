import { getEditorView } from './editorSession'
import { identifierAt, type DefinitionCandidate } from './definitionNavigation'
import { isTauri, safeInvoke } from './tauri'
import { translate } from './i18n'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { findProjectForPath } from '../utils/fileReferences'

export interface WorkspaceSymbolCandidate {
  name: string
  kind: string
  path: string
  relative: string
  line: number
  column: number
  text: string
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

let referenceRequest = 0

export async function findCallsAtActiveEditor(): Promise<void> {
  const editor = useEditorStore.getState()
  const activeTab = editor.tabs.find(tab => tab.id === editor.activeTabId)
  const view = activeTab ? getEditorView(activeTab.id) : undefined
  const identifier = view ? identifierAt(view.state, view.state.selection.main.head) : null
  const projects = useProjectStore.getState()
  if (!activeTab || !view || !identifier) {
    projects.pushToast('info', translate('请先将光标放在要查找的函数或方法上'))
    return
  }
  const project =
    findProjectForPath(projects.projects, activeTab.path) ?? projects.currentProject
  if (!project || !isTauri()) {
    projects.pushToast('info', translate('查找调用需要在桌面项目中使用'))
    return
  }

  const request = ++referenceRequest
  try {
    const response = await safeInvoke<NativeReferenceResponse>(
      '查找符号调用',
      'search_symbol_references',
      {
        root: project.path,
        symbol: identifier.name,
        maxResults: 120,
        maxFiles: 8000,
      },
    )
    if (request !== referenceRequest) return
    if (response.references.length === 0) {
      projects.pushToast(
        'info',
        translate('未找到「{symbol}」的调用', { symbol: identifier.name }),
      )
      return
    }
    const candidates: DefinitionCandidate[] = response.references.map(reference => ({
      ...reference,
      score: 0,
      callerName: reference.callerName ?? undefined,
      callerKind: reference.callerKind ?? undefined,
    }))
    useDefinitionPickerStore
      .getState()
      .openPicker(identifier.name, candidates, 'reference')
  } catch (error) {
    if (request !== referenceRequest) return
    projects.pushToast(
      'error',
      translate('查找「{symbol}」调用失败', { symbol: identifier.name }),
      String(error),
    )
  }
}

export async function searchWorkspaceSymbols(
  root: string,
  query: string,
): Promise<WorkspaceSymbolCandidate[]> {
  if (!isTauri()) return []
  const response = await safeInvoke<NativeWorkspaceSymbolResponse>(
    '搜索工作区符号',
    'search_workspace_symbols',
    {
      root,
      query,
      maxResults: 100,
      maxFiles: 8000,
    },
  )
  return response.definitions
}
