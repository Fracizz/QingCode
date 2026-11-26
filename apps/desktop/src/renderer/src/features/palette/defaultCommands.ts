import type { PaletteCommand } from './types'

// 内置命令：动作全部通过依赖注入拿到，不引用 App.tsx，也不直接碰各 store，
// 宿主没提供的动作对应命令就不生成。

export type DockToolId = 'explorer' | 'search' | 'git'

/** S 为设置分区 id 类型，宿主可直接传 features/settings 的 openSettings 与 SETTINGS_SECTIONS。 */
export type DefaultCommandDeps<S extends string = string> = {
  /** 切换右侧停靠栏工具（再次切换即收起），对应 useDock.toggleTool */
  toggleDockTool?: (tool: DockToolId) => void
  /** 收起停靠栏工具列 */
  hideDockTool?: () => void
  /** 打开设置；section 为设置分区 id */
  openSettings?: (section?: S) => void
  /** 为每个设置分区生成一条"打开设置: xxx"命令 */
  settingsSections?: ReadonlyArray<{ id: S; label: string }>
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
  { tool: 'explorer', title: '切换资源管理器', shortcut: 'Ctrl+Shift+E', keywords: ['explorer', 'files', '文件树'] },
  { tool: 'search', title: '切换搜索', shortcut: 'Ctrl+Shift+F', keywords: ['search', 'find', '查找'] },
  { tool: 'git', title: '切换源代码管理', shortcut: 'Ctrl+Shift+G', keywords: ['git', 'scm', 'source control'] },
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
        category: '视图',
        keywords: item.keywords,
        shortcut: item.shortcut,
        run: () => toggle(item.tool),
      })
    }
  }
  push(
    deps.hideDockTool && {
      id: 'view.dock.hide',
      title: '收起工作区工具栏',
      category: '视图',
      keywords: ['dock', 'panel', 'close'],
      run: deps.hideDockTool,
    },
  )
  push(
    deps.toggleSidebar && {
      id: 'view.sidebar.toggle',
      title: '切换侧栏',
      category: '视图',
      keywords: ['sidebar'],
      shortcut: 'Ctrl+B',
      run: deps.toggleSidebar,
    },
  )
  push(
    deps.quickOpen && {
      id: 'file.quickOpen',
      title: '快速打开文件',
      category: '文件',
      keywords: ['quick open', 'go to file', 'open file'],
      shortcut: 'Ctrl+P',
      ...(deps.canQuickOpen ? { when: deps.canQuickOpen } : {}),
      run: deps.quickOpen,
    },
  )
  push(
    deps.newThread && {
      id: 'thread.new',
      title: '新建会话',
      category: '会话',
      keywords: ['new thread', 'new chat', '新对话'],
      shortcut: 'Ctrl+N',
      run: deps.newThread,
    },
  )
  push(
    deps.interrupt && {
      id: 'thread.interrupt',
      title: '中断当前回复',
      category: '会话',
      keywords: ['interrupt', 'stop', '停止'],
      ...(deps.canInterrupt ? { when: deps.canInterrupt } : {}),
      run: deps.interrupt,
    },
  )
  push(
    deps.addProject && {
      id: 'project.add',
      title: '添加项目',
      category: '项目',
      keywords: ['add project', 'open folder', '打开目录'],
      run: deps.addProject,
    },
  )
  push(
    deps.addTarget && {
      id: 'target.add',
      title: '添加远程连接',
      category: '连接',
      keywords: ['ssh', 'remote', 'target', '主机'],
      run: deps.addTarget,
    },
  )
  if (deps.openSettings) {
    const open = deps.openSettings
    push({
      id: 'settings.open',
      title: '打开设置',
      category: '设置',
      keywords: ['settings', 'preferences', '偏好'],
      shortcut: 'Ctrl+,',
      run: () => open(),
    })
    for (const section of deps.settingsSections ?? []) {
      push({
        id: `settings.open.${section.id}`,
        title: `打开设置: ${section.label}`,
        category: '设置',
        keywords: ['settings', section.id],
        run: () => open(section.id),
      })
    }
  }
  push(
    deps.openMobile && {
      id: 'app.mobile',
      title: '手机连接',
      category: '应用',
      keywords: ['mobile', 'android', '配对'],
      run: deps.openMobile,
    },
  )
  push(
    deps.importLegacy && {
      id: 'app.importLegacy',
      title: '导入旧版 QingCode 数据',
      category: '应用',
      keywords: ['import', 'legacy', '迁移'],
      run: deps.importLegacy,
    },
  )
  push(
    deps.reloadWindow && {
      id: 'app.reload',
      title: '重新加载窗口',
      category: '应用',
      keywords: ['reload', 'refresh', '刷新'],
      run: deps.reloadWindow,
    },
  )
  return commands
}
