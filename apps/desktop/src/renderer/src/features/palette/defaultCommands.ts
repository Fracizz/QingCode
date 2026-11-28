import { t } from '@qn/codex-client'
import { CONNECTIONS_LABEL } from '../settings/settingsModel'
import type { PaletteCommand } from './types'

// 内置命令：动作全部通过依赖注入拿到，不引用 App.tsx，也不直接碰各 store，
// 宿主没提供的动作对应命令就不生成。
// 关键词同时收录中英文标题与分类，界面语言之外的叫法也能搜到。

export type DockToolId = 'explorer' | 'search' | 'git' | 'run' | 'schedule'

/** S 为设置分区 id 类型，宿主可直接传 features/settings 的 openSettings 与 SETTINGS_SECTIONS。 */
export type DefaultCommandDeps<S extends string = string> = {
  /** 切换右侧停靠栏工具（再次切换即收起），对应 useDock.toggleTool */
  toggleDockTool?: (tool: DockToolId) => void
  /** 收起停靠栏工具列 */
  hideDockTool?: () => void
  /** 打开设置；section 为设置分区 id */
  openSettings?: (section?: S) => void
  /** 为每个设置分区生成一条"打开设置: xxx"命令 */
  settingsSections?: ReadonlyArray<{ id: S; label: string; keywords?: readonly string[] }>
  /** 快速打开文件（Ctrl+P） */
  quickOpen?: () => void
  /** 快速打开是否可用（需已选项目且目标已连接） */
  canQuickOpen?: () => boolean
  /** 新建会话（草稿态） */
  newThread?: () => void
  /** 中断当前 turn */
  interrupt?: () => void | Promise<void>
  /** 是否有进行中的 turn，决定"中断"命令是否显示 */
  canInterrupt?: () => boolean
  /** 切换侧栏 */
  toggleSidebar?: () => void
  toggleTerminal?: () => void
  terminalShortcut?: string
  /** 添加项目（打开目录选择器） */
  addProject?: () => void
  /** 添加远程连接 */
  addTarget?: () => void
  /** 导入旧版 QingCode 数据 */
  importLegacy?: () => void
  /** 打开手机连接设置 */
  openMobile?: () => void
  /** 重新加载窗口 */
  reloadWindow?: () => void
}

const DOCK_TOOL_COMMANDS: ReadonlyArray<{ tool: DockToolId; title: string; shortcut: string; keywords: string[] }> = [
  { tool: 'explorer', title: t('切换资源管理器'), shortcut: 'Ctrl+Shift+E', keywords: ['explorer', 'files', '文件树', '切换资源管理器', 'toggle explorer', '视图', 'view'] }, // i18n-ignore: 搜索关键词，两种语言都要能匹配
  { tool: 'search', title: t('切换搜索'), shortcut: 'Ctrl+Shift+F', keywords: ['search', 'find', '查找', '切换搜索', 'toggle search', '视图', 'view'] }, // i18n-ignore: 搜索关键词，两种语言都要能匹配
  { tool: 'git', title: t('切换源代码管理'), shortcut: 'Ctrl+Shift+G', keywords: ['git', 'scm', 'source control', '切换源代码管理', 'toggle source control', '视图', 'view'] }, // i18n-ignore: 搜索关键词，两种语言都要能匹配
  { tool: 'run', title: t('切换运行面板'), shortcut: 'Ctrl+Shift+R', keywords: ['run', '运行配置', 'task', '切换运行面板', 'toggle run panel', '视图', 'view'] }, // i18n-ignore: 搜索关键词，两种语言都要能匹配
  { tool: 'schedule', title: t('切换定时任务面板'), shortcut: 'Ctrl+Shift+Y', keywords: ['schedule', '定时任务', 'cron', '视图', 'view'] }, // i18n-ignore: 搜索关键词，两种语言都要能匹配
]

export function defaultCommands<S extends string = string>(deps: DefaultCommandDeps<S>): PaletteCommand[] {
  const commands: PaletteCommand[] = []
  const push = (command: PaletteCommand | false | undefined): void => {
    if (command) commands.push(command)
  }

  if (deps.toggleDockTool) {
    const toggle = deps.toggleDockTool
    for (const item of DOCK_TOOL_COMMANDS) {
      push({
        id: `view.dock.${item.tool}`,
        title: item.title,
        category: t('视图'),
        keywords: item.keywords,
        shortcut: item.shortcut,
        run: () => toggle(item.tool),
      })
    }
  }
  push(
    deps.hideDockTool && {
      id: 'view.dock.hide',
      title: t('收起工作区工具栏'),
      category: t('视图'),
      keywords: ['dock', 'panel', 'close', '收起工作区工具栏', 'hide workspace toolbar', '视图', 'view'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      run: deps.hideDockTool,
    },
  )
  push(
    deps.toggleSidebar && {
      id: 'view.sidebar.toggle',
      title: t('切换侧栏'),
      category: t('视图'),
      keywords: ['sidebar', '切换侧栏', 'toggle sidebar', '视图', 'view'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      shortcut: 'Ctrl+B',
      run: deps.toggleSidebar,
    },
  )
  push(
    deps.toggleTerminal && {
      id: 'view.terminal.toggle',
      title: t('切换终端面板'),
      category: t('视图'),
      keywords: ['terminal', 'shell', 'console', '切换终端面板', 'toggle terminal panel', '视图', 'view'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      ...(deps.terminalShortcut ? { shortcut: deps.terminalShortcut } : {}),
      run: deps.toggleTerminal,
    },
  )
  push(
    deps.quickOpen && {
      id: 'file.quickOpen',
      title: t('快速打开文件'),
      category: t('文件'),
      keywords: ['quick open', 'go to file', 'open file', '快速打开文件', '文件', 'file'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      shortcut: 'Ctrl+P',
      ...(deps.canQuickOpen ? { when: deps.canQuickOpen } : {}),
      run: deps.quickOpen,
    },
  )
  push(
    deps.newThread && {
      id: 'thread.new',
      title: t('新建会话'),
      category: t('会话'),
      keywords: ['new thread', 'new chat', '新对话', '新建会话', 'new session', '会话', 'session'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      shortcut: 'Ctrl+N',
      run: deps.newThread,
    },
  )
  push(
    deps.interrupt && {
      id: 'thread.interrupt',
      title: t('中断当前回复'),
      category: t('会话'),
      keywords: ['interrupt', 'stop', '停止', '中断当前回复', 'stop current reply', '会话', 'session'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      ...(deps.canInterrupt ? { when: deps.canInterrupt } : {}),
      run: deps.interrupt,
    },
  )
  push(
    deps.addProject && {
      id: 'project.add',
      title: t('添加项目'),
      category: t('项目'),
      keywords: ['add project', 'open folder', '打开目录', '添加项目', '项目', 'project'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      run: deps.addProject,
    },
  )
  push(
    deps.addTarget && {
      id: 'target.add',
      title: t('添加远程连接'),
      category: CONNECTIONS_LABEL,
      keywords: ['ssh', 'remote', 'target', '主机', '添加远程连接', 'add remote connection', '连接', 'connection'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      run: deps.addTarget,
    },
  )
  if (deps.openSettings) {
    const open = deps.openSettings
    push({
      id: 'settings.open',
      title: t('打开设置'),
      category: t('设置'),
      keywords: ['settings', 'preferences', '偏好', '打开设置', 'open settings', '设置'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      shortcut: 'Ctrl+,',
      run: () => open(),
    })
    for (const section of deps.settingsSections ?? []) {
      push({
        id: `settings.open.${section.id}`,
        title: t('打开设置: {section}', { section: section.label }),
        category: t('设置'),
        keywords: ['settings', section.id, '打开设置:', 'open settings:', '设置', ...(section.keywords ?? [])], // i18n-ignore: 搜索关键词，两种语言都要能匹配
        run: () => open(section.id),
      })
    }
  }
  push(
    deps.openMobile && {
      id: 'app.mobile',
      title: t('手机连接'),
      category: t('应用'),
      keywords: ['mobile', 'android', '配对', '手机连接', 'pairing', '应用', 'app'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      run: deps.openMobile,
    },
  )
  push(
    deps.importLegacy && {
      id: 'app.importLegacy',
      title: t('导入旧版 QingCode 数据'),
      category: t('应用'),
      keywords: ['import', 'legacy', '迁移', '导入旧版 QingCode 数据', 'import legacy QingCode data', '应用', 'app'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      run: deps.importLegacy,
    },
  )
  push(
    deps.reloadWindow && {
      id: 'app.reload',
      title: t('重新加载窗口'),
      category: t('应用'),
      keywords: ['reload', 'refresh', '刷新', '重新加载窗口', 'reload window', '应用', 'app'], // i18n-ignore: 搜索关键词，两种语言都要能匹配
      run: deps.reloadWindow,
    },
  )
  return commands
}
