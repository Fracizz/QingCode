import { openUrl } from '@tauri-apps/plugin-opener'
import type { IBufferRange, Terminal } from '@xterm/xterm'
import { loadExcludeSettingsForProject } from '../excludeSettings'
import { getFileStat } from '../fileIpc'
import { translate } from '../i18n'
import { searchFiles, type SearchFilesResult } from '../searchFiles'
import { useCommandPaletteStore } from '../../store/commandPaletteStore'
import { confirmDialog } from '../../store/confirmStore'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useTerminalStore } from '../../store/terminalStore'
import {
  matchTerminalFileHits,
  parseTerminalHyperlink,
  terminalBufferFileLinks,
  terminalFileCandidates,
  terminalFileSearchName,
  type TerminalFileTarget,
} from './terminalFileLinks'

/** 文件路径和 OSC 8 链接需按住 Ctrl/Cmd 点击，普通点击留给聚焦、选择和 TUI。 */
function isLinkActivation(event: MouseEvent | undefined) {
  return !!event && (event.ctrlKey || event.metaKey)
}

/** 搜索是子串匹配，上限要留出余量；超过上限时不自动打开，交给快速打开选择。 */
const MAX_FILE_NAME_HITS = 200

/** 只保留最后一次点击：搜索较慢时，先点的结果不能盖掉后点的。 */
let activeFileOpen: AbortController | null = null

function quickOpenSeed({ path, line, column }: TerminalFileTarget) {
  if (line === undefined) return path
  return column === undefined ? `${path}:${line}` : `${path}:${line}:${column}`
}

export async function openTerminalFile(terminalId: string, target: TerminalFileTarget) {
  activeFileOpen?.abort()
  const request = new AbortController()
  activeFileOpen = request
  const { signal } = request
  const { projects, currentProject, pushToast } = useProjectStore.getState()
  const tab = useTerminalStore.getState().terminals.find(item => item.id === terminalId)
  const project = projects.find(item => item.id === tab?.projectId) ?? currentProject
  const root = project?.path ?? tab?.cwd
  if (!root) return
  const candidates = terminalFileCandidates(target.path, {
    root,
    cwd: tab?.cwd,
    projectName: project?.name,
  })
  for (const path of candidates) {
    try {
      const stat = await getFileStat({ path })
      if (stat.is_dir) continue
    } catch {
      continue // 不存在、不在允许范围内或远端不可达：试下一个候选。
    }
    if (signal.aborted) return
    await useEditorStore.getState().openFile(path, target.line, target.column)
    return
  }
  if (signal.aborted) return

  const notFound = () => pushToast('error', translate('未找到文件：{path}', { path: target.path }))
  const query = project ? terminalFileSearchName(target.path) : null
  if (!project || !query) {
    notFound()
    return
  }
  let response: SearchFilesResult
  try {
    const excludes = await loadExcludeSettingsForProject(project)
    response = await searchFiles('快速打开文件', {
      root: project.path,
      query,
      ignoreCase: true,
      fuzzy: false,
      matchSuffix: false,
      extension: null,
      extensions: null,
      limit: MAX_FILE_NAME_HITS,
      excludePatterns: excludes.searchExclude,
      useIgnoreFiles: excludes.useIgnoreFiles,
      followSymlinks: excludes.followSymlinks,
    }, signal)
  } catch (error) {
    if (signal.aborted) return
    // 搜索失败时不能断言项目里没有这个文件。
    console.warn('terminal file name search failed:', error)
    notFound()
    return
  }
  if (signal.aborted) return
  if (response.cancelled) {
    notFound()
    return
  }
  const matches = matchTerminalFileHits(target.path, response.hits)
  if (matches.length === 1 && !response.truncated) {
    await useEditorStore.getState().openFile(matches[0]!.path, target.line, target.column)
  } else if (matches.length > 0 || response.truncated) {
    useCommandPaletteStore.getState().openPalette(quickOpenSeed(target))
  } else {
    pushToast('error', translate('项目中未找到 {path}', { path: target.path }))
  }
}

function openExternalUrl(url: string) {
  void openUrl(url).catch(error => {
    useProjectStore
      .getState()
      .pushToast('error', translate('打开链接失败: {error}', { error: String(error) }))
  })
}

/** OSC 8 的目标对用户不可见，只有链接文字就是地址本身时才直接打开。 */
async function openOscWebLink(url: string, visibleText: string) {
  if (visibleText.trim() !== url) {
    const confirmed = await confirmDialog({
      title: translate('打开外部链接？'),
      message: translate('终端程序提供的链接文字与实际地址不同，请确认后再打开。'),
      detail: url,
      kind: 'warning',
      confirmLabel: translate('打开链接'),
    })
    if (!confirmed) return
  }
  openExternalUrl(url)
}

function bufferRangeText(term: Terminal, range: IBufferRange) {
  return (
    term.buffer.active
      .getLine(range.start.y - 1)
      ?.translateToString(true, range.start.x - 1, range.end.x) ?? ''
  )
}

/** xterm 的 `linkHandler`：接管 OSC 8，替代默认的原生 confirm + window.open。 */
export function createTerminalOscLinkHandler(terminalId: string, getTerm: () => Terminal | null) {
  return {
    allowNonHttpProtocols: true,
    activate: (event: MouseEvent, uri: string, range: IBufferRange) => {
      if (!isLinkActivation(event)) return
      const link = parseTerminalHyperlink(uri)
      if (!link) {
        useProjectStore
          .getState()
          .pushToast('error', translate('不支持打开此类链接：{url}', { url: uri }))
      } else if (link.kind === 'web') {
        const term = getTerm()
        void openOscWebLink(link.url, term ? bufferRangeText(term, range) : '')
      } else {
        void openTerminalFile(terminalId, link)
      }
    },
  }
}

/** 注册文件路径识别。随 Terminal 一起销毁，无需单独释放。 */
export function registerTerminalFileLinks(term: Terminal, terminalId: string) {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const links = terminalBufferFileLinks(term.buffer.active, lineNumber - 1)
        .filter(link => link.range.start.y <= lineNumber && link.range.end.y >= lineNumber)
        .map(({ range, target }) => ({
          range,
          text: target.path,
          decorations: { underline: true, pointerCursor: true },
          activate: (event: MouseEvent) => {
            if (isLinkActivation(event)) void openTerminalFile(terminalId, target)
          },
        }))
      callback(links.length ? links : undefined)
    },
  })
}
