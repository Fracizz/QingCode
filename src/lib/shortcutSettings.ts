import { COPY_RELATIVE_PATH_SHORTCUT, DEFAULT_SHORTCUTS, type ShortcutCommand } from './shortcuts'

export const SHORTCUT_COMMANDS: { id: ShortcutCommand; label: string; description: string }[] = [
  {
    id: 'openCommandPalette',
    label: '打开命令面板',
    description: '打开命令面板，搜索并运行编辑器命令。',
  },
  {
    id: 'quickOpen',
    label: '快速打开文件',
    description: '按文件名模糊搜索并打开项目中的文件。',
  },
  {
    id: 'openFile',
    label: '打开文件',
    description: '从系统文件选择器中选择并打开单个文件。',
  },
  {
    id: 'goToSymbolInEditor',
    label: '转到编辑器中的符号',
    description: '打开当前文件的符号列表，快速跳转到函数、类或标题。',
  },
  {
    id: 'searchAllProjects',
    label: '打开搜索',
    description: '打开搜索面板；若编辑器有选中文本（如双击单词），会自动填入搜索框。',
  },
  {
    id: 'toggleTerminal',
    label: '显示或隐藏终端',
    description: '显示或隐藏终端面板。',
  },
  {
    id: 'openSettings',
    label: '打开设置',
    description: '打开设置面板。',
  },
  {
    id: 'goToLine',
    label: '转到行',
    description: '跳转到当前文件中的指定行号。',
  },
  {
    id: 'navigateBack',
    label: '后退',
    description: '返回上一次编辑位置（打开文件、转到行、搜索跳转等）。',
  },
  {
    id: 'navigateForward',
    label: '前进',
    description: '前进到下一次编辑位置。',
  },
  {
    id: 'toggleMinimap',
    label: '切换小地图',
    description: '显示或隐藏编辑区右侧的代码小地图。',
  },
  {
    id: 'togglePanelLayout',
    label: '切换面板布局',
    description: '依次切换：经典 → 编辑器+终端 → 编辑器+双终端 → 终端工作台。标题栏可直接选择。',
  },
  {
    id: 'renameInExplorer',
    label: '资源管理器: 重命名',
    description: '在文件树中行内重命名当前选中的文件或文件夹。',
  },
  {
    id: 'findInTerminal',
    label: '查找（编辑器 / 终端）',
    description:
      '编辑器内：打开查找并填入选中文本（如双击单词）。终端内：在终端输出中查找。',
  },
  {
    id: 'clearTerminal',
    label: '终端: 清空',
    description: '清空当前终端缓冲区（需焦点在终端内）。',
  },
]

/** Editor-bound shortcuts shown as read-only (not remappable here). */
export const FIXED_SHORTCUTS: { shortcut: string; label: string; description: string }[] = [
  {
    shortcut: 'Ctrl+F',
    label: '查找',
    description: '编辑器内打开查找并填入选中文本（如双击单词）；终端内查找终端输出。',
  },
  {
    shortcut: 'Ctrl+S',
    label: '保存文件',
    description: '保存当前编辑器中的文件。',
  },
  {
    shortcut: 'Ctrl+Shift+C',
    label: '复制路径',
    description: '复制当前文件或选中项的完整路径。',
  },
  {
    shortcut: COPY_RELATIVE_PATH_SHORTCUT,
    label: '复制相对路径',
    description: '复制当前文件相对项目根目录的路径（POSIX 斜杠）。',
  },
  {
    shortcut: 'Alt+C',
    label: '复制为文件引用',
    description: '复制当前文件的引用（含行号范围），便于粘贴到对话或文档。',
  },
  {
    shortcut: 'Shift+Alt+F',
    label: '格式化文档',
    description: '使用 Prettier、rustfmt、shfmt、ruff/black 或 gofmt 格式化当前文件（需本机已安装对应工具）。',
  },
]

/** Search uses the same labels, descriptions and default bindings as the view. */
export const SHORTCUT_SEARCH_TERMS = [
  '快捷键', '键盘', '键盘快捷方式', 'shortcuts', 'keyboard',
  ...SHORTCUT_COMMANDS.flatMap(command => [command.label, command.description]),
  ...FIXED_SHORTCUTS.flatMap(item => [item.label, item.description, item.shortcut]),
  ...Object.values(DEFAULT_SHORTCUTS).filter(Boolean),
]
