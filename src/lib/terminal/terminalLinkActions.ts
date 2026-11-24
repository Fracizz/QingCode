import { dataDir, homeDir, localDataDir, tempDir } from '@tauri-apps/api/path'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { IBufferRange, Terminal } from '@xterm/xterm'
import { loadExcludeSettingsForProject } from '../excludeSettings'
import { getFileStat } from '../fileIpc'
import { translate } from '../i18n'
import { authorizeExistingFile, authorizeRemoteOutsideFile } from '../pathAllowlist'
import { searchFiles, type SearchFilesResult } from '../searchFiles'
import { useCommandPaletteStore } from '../../store/commandPaletteStore'
import { confirmDialog } from '../../store/confirmStore'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useTerminalStore } from '../../store/terminalStore'
import {
  isTerminalPathUnderRoot,
  matchTerminalFileHits,
  parseTerminalHyperlink,
  terminalBufferFileLinkAt,
  terminalBufferFileLinks,
  terminalFileCandidates,
  terminalFileSearchName,
  terminalPathVariable,
  type TerminalFileTarget,
  type TerminalPathEnv,
} from './terminalFileLinks'

/** 文件路径和 OSC 8 链接需按住 Ctrl/Cmd 点击，普通点击留给聚焦、选择和 TUI。 */
function isLinkActivation(event: MouseEvent | undefined) {
  return !!event && (event.ctrlKey || event.metaKey)
}

/** 已被 xterm 链接（文件路径、网址、OSC 8）处理的 mouseup，点击兜底不再重复打开。 */
const activatedLinkEvents = new WeakSet<MouseEvent>()

export function markTerminalLinkActivated(event: MouseEvent | undefined) {
  if (event) activatedLinkEvents.add(event)
}

/** 搜索是子串匹配，上限要留出余量；超过上限时不自动打开，交给快速打开选择。 */
const MAX_FILE_NAME_HITS = 200

/** 只保留最后一次点击：搜索较慢时，先点的结果不能盖掉后点的。 */
let activeFileOpen: AbortController | null = null

function quickOpenSeed({ path, line, column }: TerminalFileTarget) {
  if (line === undefined) return path
  return column === undefined ? `${path}:${line}` : `${path}:${line}:${column}`
}

/** 只取本机的几个路径目录，不把任意环境变量暴露给前端。 */
let pathEnvCache: Promise<TerminalPathEnv> | null = null

function terminalPathEnv(): Promise<TerminalPathEnv> {
  pathEnvCache ??= (async () => {
    const settle = (dir: () => Promise<string>) => dir().catch(() => undefined)
    const [home, temp, roaming, local] = await Promise.all([
      settle(homeDir),
      settle(tempDir),
      settle(dataDir),
      settle(localDataDir),
    ])
    return {
      HOME: home,
      USERPROFILE: home,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      APPDATA: roaming,
      LOCALAPPDATA: local,
    }
  })()
  return pathEnvCache
}

interface OpenTerminalFileOptions {
  /** 链接目标对用户不可见（OSC 8），打开项目外的文件前先确认。 */
  confirmOutsideProject?: boolean
}

/**
 * 候选路径能否作为文件打开。项目外的文件不在沙箱里，用户点击后只授权这一个已存在的
 * 普通文件：本机文件走路径沙箱，同一 SSH 连接上的远程文件只读授权（不能保存或执行）。
 */
async function isOpenableFile(path: string, root: string, options: OpenTerminalFileOptions) {
  try {
    return !(await getFileStat({ path })).is_dir
  } catch {
    // 不存在、不在允许范围内或远端不可达。
  }
  if (isTerminalPathUnderRoot(path, root)) return false
  if (options.confirmOutsideProject) {
    const confirmed = await confirmDialog({
      title: translate('打开项目外的文件？'),
      message: translate('终端程序提供的链接指向当前项目之外的文件，请确认后再打开。'),
      detail: path,
      kind: 'warning',
      confirmLabel: translate('打开文件'),
    })
    if (!confirmed) return false
  }
  try {
    return path.startsWith('ssh://')
      ? await authorizeRemoteOutsideFile(path)
      : await authorizeExistingFile(path)
  } catch (error) {
    console.warn('authorize terminal file failed:', error)
    return false
  }
}

export async function openTerminalFile(
  terminalId: string,
  target: TerminalFileTarget,
  options: OpenTerminalFileOptions = {},
) {
  activeFileOpen?.abort()
  const request = new AbortController()
  activeFileOpen = request
  const { signal } = request
  const { projects, currentProject, pushToast } = useProjectStore.getState()
  const tab = useTerminalStore.getState().terminals.find(item => item.id === terminalId)
  const project = projects.find(item => item.id === tab?.projectId) ?? currentProject
  const root = project?.path ?? tab?.cwd
  if (!root) return
  const env = terminalPathVariable(target.path) ? await terminalPathEnv() : undefined
  if (signal.aborted) return
  const candidates = terminalFileCandidates(target.path, {
    root,
    cwd: tab?.cwd,
    projectName: project?.name,
    env,
  })
  for (const path of candidates) {
    if (!(await isOpenableFile(path, root, options))) continue
    if (signal.aborted) return
    await useEditorStore.getState().openFile(path, target.line, target.column)
    return
  }
  if (signal.aborted) return

  const query = project ? terminalFileSearchName(target.path) : null
  // 远端路径变量（`~`、`%TEMP%`）无法在本机展开，没有候选；文件可能存在，不能报"未找到"。
  if (root.startsWith('ssh://') && !candidates.length && !query) {
    pushToast('error', translate('无法在本机展开远程终端的路径变量：{path}', { path: target.path }))
    return
  }
  const notFound = () => pushToast('error', translate('未找到文件：{path}', { path: target.path }))
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
      markTerminalLinkActivated(event)
      const link = parseTerminalHyperlink(uri)
      if (!link) {
        useProjectStore
          .getState()
          .pushToast('error', translate('不支持打开此类链接：{url}', { url: uri }))
      } else if (link.kind === 'web') {
        const term = getTerm()
        void openOscWebLink(link.url, term ? bufferRangeText(term, range) : '')
      } else {
        void openTerminalFile(terminalId, link, { confirmOutsideProject: true })
      }
    },
  }
}

/** 鼠标所在单元格（0 起始的列与 buffer 行）；不在字符区内返回 null。 */
function bufferCellAt(term: Terminal, event: MouseEvent) {
  const screen = term.element?.querySelector('.xterm-screen')
  if (!screen || !term.cols || !term.rows) return null
  const rect = screen.getBoundingClientRect()
  const col = Math.floor(((event.clientX - rect.left) / rect.width) * term.cols)
  const row = Math.floor(((event.clientY - rect.top) / rect.height) * term.rows)
  if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return null
  return { x: col, y: term.buffer.active.viewportY + row }
}

/**
 * 注册文件路径识别，需在 `term.open()` 之后调用。随 Terminal 一起销毁，无需单独释放。
 *
 * xterm 只在悬停时识别链接并缓存：Claude Code 等程序持续重绘时，若某一帧恰好渲染在
 * 该行被擦除、尚未重写的间隙，悬停链接就会丢失，直到鼠标移到别的格子才重新识别，
 * 于是 Ctrl+点击没有反应。所以 xterm 未处理的 Ctrl+点击，按松开这一刻的内容再识别一次。
 */
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
            if (!isLinkActivation(event)) return
            markTerminalLinkActivated(event)
            void openTerminalFile(terminalId, target)
          },
        }))
      callback(links.length ? links : undefined)
    },
  })

  const element = term.element
  if (!element) return
  let pressed: { x: number; y: number } | null = null
  // 冒泡阶段挂在 .xterm 根节点上，晚于 xterm 自己在 .xterm-screen 上的链接处理。
  element.addEventListener('mousedown', event => {
    pressed = event.button === 0 ? bufferCellAt(term, event) : null
  })
  element.addEventListener('mouseup', event => {
    const down = pressed
    pressed = null
    if (event.button !== 0 || !isLinkActivation(event) || activatedLinkEvents.has(event)) return
    const cell = bufferCellAt(term, event)
    // 拖动选择不算点击。
    if (!cell || !down || down.x !== cell.x || down.y !== cell.y) return
    const target = terminalBufferFileLinkAt(term.buffer.active, cell.x, cell.y)
    if (target) void openTerminalFile(terminalId, target)
  })
}
