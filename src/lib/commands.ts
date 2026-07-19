import { openNewAppWindow } from './appWindow'
import { requestAppClose } from './appClose'
import { getAutoSaveSettings } from './autoSave'
import { saveScopedAutoSaveSettings } from './autoSaveSettings'
import { formatDocument } from './formatDocument'
import { translate } from './i18n'
import {
  ensureSettingsFile,
  resolveGlobalSettingsPath,
} from './projectSettings'
import { isTauri } from './tauri'
import {
  getResolvedTheme,
  loadTheme,
  saveTheme,
  type AppTheme,
} from './themeSettings'
import type { ShortcutCommand, ShortcutMap } from './shortcuts'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useRunConfigStore } from '../store/runConfigStore'
import { promptDialog } from '../store/promptStore'
import { useSymbolPickerStore } from '../store/symbolPickerStore'
import { useUIStore } from '../store/uiStore'
import { confirmDiscardTabs } from '../utils/dirtyTabs'
import { openGitCompareWithHead } from './gitCompare'
import {
  saveVisibleProjectsAsWorkspace,
} from './namedWorkspaceActions'

export type AppCommand = {
  id: string
  /** Chinese source string used as i18n key. */
  title: string
  titleValues?: Record<string, string | number>
  /** Extra fuzzy-match tokens (language-agnostic). */
  keywords?: string
  /** Static keybinding hint (e.g. Shift+Alt+F). */
  shortcut?: string
  /** Remappable shortcut looked up from ShortcutMap. */
  shortcutCommand?: ShortcutCommand
  when?: () => boolean
  run: () => void | Promise<void>
}

export type RankedCommand = AppCommand & { score: number }

/** Subsequence fuzzy score; higher is better. 0 means no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = text.toLowerCase()
  if (t === q) return 1000
  if (t.startsWith(q)) return 800 + Math.min(q.length, 50)
  const idx = t.indexOf(q)
  if (idx >= 0) return 600 - idx + Math.min(q.length, 50)

  let ti = 0
  let score = 0
  let consecutive = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    if (found === ti) {
      consecutive += 1
      score += 4 + consecutive
    } else {
      consecutive = 0
      score += 1
    }
    ti = found + 1
  }
  return score
}

export function filterCommands(
  commands: AppCommand[],
  query: string,
  translateTitle: (title: string, values?: Record<string, string | number>) => string = translate,
): RankedCommand[] {
  const trimmed = query.trim()
  const ranked: RankedCommand[] = []
  for (const command of commands) {
    if (command.when && !command.when()) continue
    if (!trimmed) {
      ranked.push({ ...command, score: 1 })
      continue
    }
    const title = translateTitle(command.title, command.titleValues)
    const haystack = `${title} ${command.title} ${command.keywords ?? ''}`
    const score = fuzzyScore(query, haystack)
    if (score > 0) ranked.push({ ...command, score })
  }
  if (trimmed) {
    ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
  }
  return ranked
}

export function resolveCommandShortcut(
  command: AppCommand,
  shortcuts: ShortcutMap,
): string | undefined {
  if (command.shortcutCommand) {
    const binding = shortcuts[command.shortcutCommand]
    return binding.trim() ? binding : undefined
  }
  return command.shortcut
}

function activeEditableTab() {
  const { tabs, activeTabId } = useEditorStore.getState()
  const tab = tabs.find(t => t.id === activeTabId) ?? null
  if (!tab || tab.openError || tab.viewMode === 'view' || tab.content === undefined) return null
  return tab
}

function cycleTheme() {
  const order: AppTheme[] = ['dark', 'light', 'forest']
  const current = loadTheme()
  const resolved = current === 'auto' ? getResolvedTheme('auto') : current
  const idx = order.indexOf(resolved === 'forest' ? 'forest' : resolved)
  const next = order[(Math.max(0, idx) + 1) % order.length]
  saveTheme(next)
  const label = next === 'dark' ? '深色' : next === 'light' ? '浅色' : '森林'
  useProjectStore.getState().pushToast('info', translate('已切换主题：{theme}', { theme: translate(label) }))
}

async function openUserSettingsJson() {
  const pushToast = useProjectStore.getState().pushToast
  if (!isTauri()) {
    pushToast('error', translate('当前环境无法打开设置文件'))
    return
  }
  try {
    const path = await resolveGlobalSettingsPath()
    await ensureSettingsFile(path, {
      scope: 'global',
      writeTemplate: false,
      upgradeComments: true,
    })
    await useEditorStore.getState().openFile(path)
    useUIStore.getState().setView('explorer')
    pushToast('success', translate('已在编辑器中打开设置文件'))
  } catch (reason) {
    pushToast('error', translate('打开设置失败: {error}', { error: String(reason) }))
  }
}

async function toggleAutoSave() {
  const pushToast = useProjectStore.getState().pushToast
  const current = getAutoSaveSettings()
  const nextMode = current.mode === 'off' ? 'afterDelay' : 'off'
  try {
    await saveScopedAutoSaveSettings('global', { mode: nextMode, delay: current.delay })
    pushToast(
      'info',
      nextMode === 'off' ? translate('已关闭自动保存') : translate('已开启自动保存'),
    )
  } catch (error) {
    pushToast('error', translate('保存自动保存设置失败: {error}', { error: String(error) }))
  }
}

/** Build the command list from current app state (call when opening / filtering). */
export function buildCommands(): AppCommand[] {
  const project = useProjectStore.getState().currentProject
  const pushToast = useProjectStore.getState().pushToast
  const {
    requestNewFile,
    requestGlobalSearch,
    requestSettings,
    requestToggleTerminal,
    openProjectManager,
    openWorkspaceManager,
    setView,
    toggleActivityView,
  } = useUIStore.getState()
  const { saveFile, saveAs, closeTab, openFile } = useEditorStore.getState()
  const activeTab = activeEditableTab()
  const activeTabId = useEditorStore.getState().activeTabId
  const dirtyCount = useEditorStore.getState().getAllTabs().filter(t => t.dirty).length
  const configs = project
    ? (useRunConfigStore.getState().configsByProject[project.id] ?? [])
    : []

  const commands: AppCommand[] = [
    {
      id: 'file.new',
      title: '新建文件',
      keywords: 'new file create',
      run: () => {
        if (!project) {
          pushToast('info', translate('请先选择或添加项目'))
          return
        }
        requestNewFile()
      },
    },
    {
      id: 'file.newWindow',
      title: '新建窗口',
      keywords: 'new window',
      run: () => {
        if (!isTauri()) {
          pushToast('error', translate('当前环境无法新建窗口'))
          return
        }
        void openNewAppWindow().catch(e => {
          pushToast('error', translate('新建窗口失败: {error}', { error: String(e) }))
        })
      },
    },
    {
      id: 'file.openFolder',
      title: '打开文件夹',
      keywords: 'open folder project add',
      run: () => void useProjectStore.getState().addProjectFromDialog(),
    },
    {
      id: 'file.save',
      title: '保存',
      keywords: 'save file',
      shortcut: 'Ctrl+S',
      when: () => !!activeTab,
      run: () => {
        if (activeTabId) void saveFile(activeTabId)
      },
    },
    {
      id: 'file.saveAs',
      title: '另存为',
      keywords: 'save as',
      when: () => !!activeTab,
      run: () => {
        if (activeTabId) void saveAs(activeTabId)
      },
    },
    {
      id: 'file.saveAll',
      title: '全部保存',
      keywords: 'save all',
      when: () => dirtyCount > 0,
      run: async () => {
        const dirtyTabs = useEditorStore.getState().getAllTabs().filter(tab => tab.dirty)
        await Promise.all(dirtyTabs.map(tab => saveFile(tab.id)))
      },
    },
    {
      id: 'file.toggleAutoSave',
      title: '自动保存',
      keywords: 'autosave auto save',
      run: () => void toggleAutoSave(),
    },
    {
      id: 'file.closeEditor',
      title: '关闭编辑器',
      keywords: 'close tab editor',
      when: () => !!useEditorStore.getState().activeTabId,
      run: async () => {
        const tab =
          useEditorStore.getState().tabs.find(t => t.id === useEditorStore.getState().activeTabId) ??
          null
        if (!tab) return
        if (await confirmDiscardTabs([tab], '关闭文件')) closeTab(tab.id)
      },
    },
    {
      id: 'editor.format',
      title: '格式化文档',
      keywords: 'format document prettier rustfmt',
      shortcut: 'Shift+Alt+F',
      run: () => void formatDocument(),
    },
    {
      id: 'git.compareHead',
      title: '与 Git HEAD 比较',
      keywords: 'git diff compare head',
      when: () => !!activeTab && isTauri(),
      run: () => {
        if (activeTab) void openGitCompareWithHead(activeTab.path)
      },
    },
    {
      id: 'editor.goToSymbol',
      title: '转到编辑器中的符号',
      keywords: 'go to symbol outline functions classes headings',
      shortcutCommand: 'goToSymbolInEditor',
      when: () => {
        const { tabs, activeTabId } = useEditorStore.getState()
        const tab = tabs.find(t => t.id === activeTabId)
        return Boolean(tab && !tab.openError && !tab.loading)
      },
      run: () => useSymbolPickerStore.getState().openPicker(),
    },
    {
      id: 'editor.goToLine',
      title: '转到行',
      keywords: 'go to line jump ln col',
      shortcutCommand: 'goToLine',
      when: () => !!activeTab,
      run: async () => {
        if (!activeTab) return
        const currentLine = useEditorStore.getState().cursor?.line ?? 1
        const input = await promptDialog({
          title: translate('转到行'),
          message: translate('行号'),
          defaultValue: String(currentLine),
          confirmLabel: translate('跳转'),
          validate: value => {
            const line = Number(value.trim())
            if (!Number.isFinite(line) || line < 1 || !Number.isInteger(line)) {
              return translate('请输入有效行号')
            }
            return null
          },
        })
        if (!input) return
        useEditorStore.setState({
          pendingReveal: { path: activeTab.path, line: Math.floor(Number(input)) },
        })
      },
    },
    {
      id: 'view.explorer',
      title: '资源管理器',
      keywords: 'explorer files sidebar',
      run: () => setView('explorer'),
    },
    {
      id: 'view.search',
      title: '打开搜索',
      keywords: 'search find global',
      shortcutCommand: 'searchAllProjects',
      run: () => requestGlobalSearch(),
    },
    {
      id: 'view.run',
      title: '运行配置',
      keywords: 'run task configurations',
      run: () => setView('run'),
    },
    {
      id: 'view.settings',
      title: '打开设置',
      keywords: 'settings preferences',
      shortcutCommand: 'openSettings',
      run: () => requestSettings(),
    },
    {
      id: 'view.settingsJson',
      title: '打开设置 JSON',
      keywords: 'settings.json default-settings',
      run: () => void openUserSettingsJson(),
    },
    {
      id: 'view.toggleSidebar',
      title: '切换侧边栏',
      keywords: 'toggle sidebar panel',
      run: () => {
        const { view } = useUIStore.getState()
        toggleActivityView(view)
      },
    },
    {
      id: 'view.toggleTerminal',
      title: '切换终端',
      keywords: 'terminal console',
      shortcutCommand: 'toggleTerminal',
      run: () => requestToggleTerminal(),
    },
    {
      id: 'view.toggleMinimap',
      title: '切换小地图',
      keywords: 'minimap glance codeglance overview',
      shortcutCommand: 'toggleMinimap',
      run: () => {
        void import('./minimapSettings').then(async ({ getMinimapEnabled, saveScopedMinimapEnabled }) => {
          const project = useProjectStore.getState().currentProject
          const next = !getMinimapEnabled()
          try {
            await saveScopedMinimapEnabled('global', next, project)
          } catch (error) {
            useProjectStore
              .getState()
              .pushToast('error', translate('保存小地图设置失败: {error}', { error: String(error) }))
          }
        })
      },
    },
    {
      id: 'view.theme',
      title: '切换颜色主题',
      keywords: 'theme dark light forest toggle',
      run: () => cycleTheme(),
    },
    {
      id: 'project.manage',
      title: '项目管理',
      keywords: 'projects manage jump switch',
      run: () => openProjectManager(),
    },
    {
      id: 'workspace.manage',
      title: '多项目工作区',
      keywords: 'workspace multi project group named',
      run: () => openWorkspaceManager(),
    },
    {
      id: 'workspace.saveVisible',
      title: '保存为多项目工作区',
      keywords: 'workspace save group projects',
      run: () => void saveVisibleProjectsAsWorkspace(),
    },
    {
      id: 'project.add',
      title: '添加项目',
      keywords: 'add project folder',
      run: () => void useProjectStore.getState().addProjectFromDialog(),
    },
    {
      id: 'app.quit',
      title: '退出',
      keywords: 'quit exit close app',
      run: () => void requestAppClose(),
    },
  ]

  for (const file of useProjectStore.getState().recentFiles.slice(0, 8)) {
    const name = file.path.split(/[/\\]/).pop() || file.path
    commands.push({
      id: `recent:${file.path}`,
      title: '打开最近文件「{name}」',
      titleValues: { name },
      keywords: `recent ${file.path}`,
      run: () => void openFile(file.path),
    })
  }

  if (project) {
    for (const config of configs) {
      commands.push({
        id: `run:${config.id}`,
        title: '运行「{name}」',
        titleValues: { name: config.name },
        keywords: `run task ${config.name}`,
        run: () => void useRunConfigStore.getState().runConfig(project, config),
      })
    }
  }

  return commands
}
