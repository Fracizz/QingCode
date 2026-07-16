import { create } from 'zustand'

export type AppLanguage = 'zh-CN' | 'en'

type Values = Record<string, string | number>

const LANGUAGE_KEY = 'qingcode:language'
const DEFAULT_LANGUAGE: AppLanguage = 'zh-CN'

const english: Record<string, string> = {
  '语言': 'Language',
  '选择界面显示语言。': 'Choose the language used throughout the interface.',
  '简体中文': 'Simplified Chinese',
  '设置': 'Settings',
  '外观': 'Appearance',
  '选择界面整体主题色调。': 'Choose the overall interface theme.',
  '字体': 'Font',
  '界面字体与代码/终端等宽字体分开设置；代码与终端共用同一字体族，字号可独立调整。':
    'Set interface and monospace fonts separately; the editor and terminal share one font family while their sizes remain independent.',
  '界面与代码/终端字体均支持系统默认；代码与终端共用同一等宽字体族，字号可独立调整。':
    'The interface, editor, and terminal all support the system default; the editor and terminal share one monospace font family while their sizes remain independent.',
  '终端': 'Terminal',
  '配置默认启动方式与终端配置文件。': 'Configure the default startup behavior and terminal profiles.',
  '深色': 'Dark',
  '浅色': 'Light',
  '跟随系统': 'System',
  '常驻深色': 'Always dark',
  '常驻浅色': 'Always light',
  '随操作系统明暗自动切换': 'Follow the system appearance',
  '当前解析为：': 'Currently using: ',
  '（操作系统切换明暗时自动跟随）': ' (updates automatically when the system appearance changes)',
  '界面字体': 'Interface font',
  '用于菜单、侧栏、标签和状态栏。': 'Used for menus, sidebars, tabs, and the status bar.',
  '用于菜单、侧栏、标签和状态栏，支持选择系统默认字体。':
    'Used for menus, sidebars, tabs, and the status bar. Supports the system default font.',
  '界面字体大小': 'Interface font size',
  '代码与终端字体': 'Editor and terminal font',
  '代码编辑器与终端共用同一等宽字体族。': 'The editor and terminal use the same monospace font family.',
  '代码编辑器与终端共用同一等宽字体族，支持选择系统默认字体。':
    'The editor and terminal use the same monospace font family. Supports the system default font.',
  '代码字体大小': 'Editor font size',
  '仅影响编辑器中的代码。': 'Only affects code in the editor.',
  '终端字体大小': 'Terminal font size',
  '字号': 'Font size',
  '代码字号': 'Editor font size',
  '终端字号': 'Terminal font size',
  '仅影响终端面板。': 'Only affects the terminal panel.',
  '系统默认': 'System default',
  '资源管理器': 'Explorer',
  '搜索': 'Search',
  '运行配置': 'Run Configurations',
  '添加项目': 'Add Project',
  '项目管理': 'Manage Projects',
  '更多项目': 'More Projects',
  '新增空项目': 'New Empty Project',
  '重命名项目': 'Rename Project',
  '重新定位项目': 'Relocate Project',
  '在文件管理器中打开': 'Open in File Explorer',
  '从顶栏隐藏': 'Hide from Title Bar',
  '添加文件夹项目': 'Add Folder Project',
  '新建终端项目': 'New Terminal Project',
  '当前为浏览器预览模式，项目、文件、终端等功能不可用。请使用':
    'This is a browser preview. Projects, files, and terminals are unavailable. Run',
  '启动，并在弹出的桌面窗口中操作。': 'and use the desktop window that opens.',
  '当前项目「{name}」暂无终端，点击标签栏 + 新建':
    'The current project, “{name}”, has no terminal. Use + in the tab bar to create one.',
  '请先选择或添加项目，终端将默认基于当前项目创建':
    'Select or add a project first. New terminals start in the current project.',
  '未打开项目': 'No project opened',
  '文件夹': 'folder',
  '文件': 'file',
  '新建{kind}': 'New {kind}',
  '已新建{kind}: {name}': 'Created {kind}: {name}',
  '路径已复制': 'Path copied',
  '打开项目目录失败: {error}': 'Could not open project folder: {error}',
  '复制路径失败: {error}': 'Could not copy path: {error}',
  '无法确定该路径所属项目': 'Could not determine which project owns this path',
  '文件引用已复制': 'File reference copied',
  '复制引用失败: {error}': 'Could not copy reference: {error}',
  '无法确定该目录所属项目': 'Could not determine which project owns this folder',
  '重命名': 'Rename',
  '文件夹新名称': 'New folder name',
  '文件新名称': 'New file name',
  '已重命名为: {name}': 'Renamed to: {name}',
  '永久删除': 'Delete Permanently',
  '确定永久删除{kind}「{name}」？': 'Permanently delete {kind} “{name}”?',
  '文件夹内的全部内容都会被删除，且无法撤销。': 'All contents in this folder will be deleted. This cannot be undone.',
  '此操作无法撤销。': 'This action cannot be undone.',
  '删除': 'Delete',
  '取消': 'Cancel',
  '已删除: {name}': 'Deleted: {name}',
  '在文件管理器中打开失败: {error}': 'Could not open in File Explorer: {error}',
  '刷新': 'Refresh',
  '当前项目': 'Current Project',
  '切换到此项目': 'Switch to This Project',
  '新建终端': 'New Terminal',
  '在此项目内搜索': 'Search in This Project',
  '新建文件': 'New File',
  '新建文件夹': 'New Folder',
  '刷新项目': 'Refresh Project',
  '复制路径': 'Copy Path',
  '复制为文件引用': 'Copy as File Reference',
  '打开文件': 'Open File',
  '新建文件（同目录）': 'New File in This Folder',
  '新建文件夹（同目录）': 'New Folder in This Folder',
  '在此处打开终端': 'Open Terminal Here',
  '在此文件夹中搜索': 'Search in This Folder',
  '在文件管理器中显示': 'Reveal in File Explorer',
  '在侧边栏定位当前文件': 'Locate Active File in Explorer',
  '目录不可用，请重新定位': 'Folder unavailable. Please relocate the project.',
  '空文件夹': 'Empty folder',
  '请先选择或添加项目': 'Select or add a project first',
  '配置保存在': 'Configuration is saved in',
  '（项目根目录相对路径）': ' (relative to the project root)',
  '尚未配置运行任务': 'No run tasks configured',
  '新建配置': 'New Configuration',
  '运行中 · {count}': 'Running · {count}',
  '空闲': 'Idle',
  '编辑': 'Edit',
  '无任务': 'No tasks',
  '命令': 'Command',
  '脚本': 'Script',
  '新建运行配置': 'New Run Configuration',
  '运行': 'Run',
  '停止': 'Stop',
  '关闭终端': 'Close Terminal',
  '关闭其它终端': 'Close Other Terminals',
  '关闭全部终端': 'Close All Terminals',
  '「{name}」仍在运行': '“{name}” is still running',
  '将终止 {count} 个运行中的终端': 'This will terminate {count} running terminal(s)',
  '将终止当前项目的 {count} 个运行中终端': 'This will terminate {count} running terminal(s) in the current project',
  '关闭后将终止当前 shell 进程，会话中的未保存输出会丢失。': 'Closing will terminate the current shell process and discard unsaved output.',
  '关闭后将终止对应 shell 进程，会话中的未保存输出会丢失。': 'Closing will terminate the relevant shell processes and discard unsaved output.',
  '终止并关闭': 'Terminate and Close',
  '请先选择或添加项目，再创建终端': 'Select or add a project before creating a terminal',
  '已达到每个项目 {count} 个终端的上限': 'Maximum of {count} terminals per project reached',
  '未命名配置': 'Unnamed Profile',
  '（默认）': ' (default)',
  '新建终端（默认配置）': 'New Terminal (Default Profile)',
  '关闭': 'Close',
  '关闭其它': 'Close Others',
  '关闭全部': 'Close All',
  '重命名终端': 'Rename Terminal',
  '重启终端{exitCode}': 'Restart Terminal{exitCode}',
  '（退出码 {code}）': ' (exit code {code})',
  '再次点击关闭终端': 'Click again to close terminal',
  '确认关闭终端': 'Confirm close terminal',
  '左键：默认配置；右键：选择终端配置': 'Left click: default profile; right click: choose a profile',
  '请先选择项目': 'Select a project first',
  '全部项目': 'All Projects',
  '限定于：': 'Limited to: ',
  '清除目录限定，回到当前项目根': 'Clear folder limit and return to the current project root',
  '内容': 'Content',
  '文件名': 'File Name',
  '搜索中': 'Searching',
  '搜索文件内容…': 'Search file contents…',
  '在 {type} 文件中搜索内容…': 'Search contents in {type} files…',
  '通配符匹配，如 *.tsx 或 test*Util.ts': 'Wildcard match, e.g. *.tsx or test*Util.ts',
  '在 {type} 中搜索文件名…': 'Search file names in {type}…',
  '输入后缀/扩展名，如 .ts 或 ts': 'Enter a suffix or extension, e.g. .ts or ts',
  '模糊匹配文件名…': 'Fuzzy match file names…',
  '搜索文件名，支持 * 通配符…': 'Search file names; * wildcards supported…',
  '忽略大小写': 'Ignore case',
  '模糊匹配（子序列）': 'Fuzzy match (subsequence)',
  '模糊': 'Fuzzy',
  '按后缀/扩展名匹配': 'Match by suffix or extension',
  '后缀': 'Suffix',
  '按文件类型筛选': 'Filter by file type',
  '清除类型筛选': 'Clear file type filter',
  '全部类型': 'All Types',
  '常见分组': 'Common Groups',
  '扩展名': 'Extensions',
  '配置': 'Configuration',
  '文档': 'Documentation',
  '输入关键词搜索文件内容': 'Enter keywords to search file contents',
  '输入关键词、通配符（*）或选择常见类型开始搜索': 'Enter keywords, a wildcard (*), or choose a common type to start searching',
  '搜索中…': 'Searching…',
  '无匹配结果': 'No matches found',
  '{matches} 个匹配 · {files} 个文件{truncated}': '{matches} matches · {files} files{truncated}',
  ' · 已截断': ' · truncated',
  '{count} 个结果': '{count} results',
  '展开全部': 'Expand All',
  '折叠全部': 'Collapse All',
  '…可能还有更多匹配': '…more matches may be available',
  '（已由后缀筛选锁定）': ' (locked by suffix filter)',
  '编辑运行配置': 'Edit Run Configuration',
  '名称': 'Name',
  '如：前后端': 'e.g. Backend and Frontend',
  '从常见模板填充（Python 后端 + 前端）': 'Fill from a common template (Python backend + frontend)',
  '模板': 'Template',
  '任务（每个任务启动一个终端）': 'Tasks (each task starts a terminal)',
  '添加任务': 'Add Task',
  '点击“添加任务”或“模板”快速开始': 'Click “Add Task” or “Template” to get started',
  '保存至': 'Saved to',
  '保存': 'Save',
  '任务名（可选，如：后端）': 'Task name (optional, e.g. Backend)',
  '删除任务': 'Delete Task',
  '命令（CMD）': 'Command (CMD)',
  'ps1 脚本': 'ps1 Script',
  'bat 脚本': 'bat Script',
  'sh 脚本': 'sh Script',
  '脚本(按扩展名)': 'Script (by extension)',
  'Windows 下使用 CMD，可用 && 连接命令；换行会自动转为 &&。工作目录已填时无需再写 cd。':
    'Uses CMD on Windows. Join commands with &&; line breaks are converted to &&. No need to add cd when a working directory is set.',
  '脚本路径': 'Script path',
  '工作目录': 'Working directory',
  '留空=项目根；可相对，如 backend/': 'Leave empty for project root; relative paths such as backend/ are allowed',
  '环境变量': 'Environment variables',
  '添加': 'Add',
  '无': 'None',
  '确定': 'Confirm',
  '不能为空': 'Cannot be empty',
  '未选择项目': 'No project selected',
  'Ctrl + Shift + C：复制完整文件路径；Alt + C：复制 @项目/相对路径#L行号 引用':
    'Ctrl + Shift + C: copy full file path; Alt + C: copy @project/relative-path#Lline reference',
  'Ctrl+Shift+C 路径 · Alt+C 文件引用': 'Ctrl+Shift+C Path · Alt+C File Reference',
  '{running}/{total} 运行中': '{running}/{total} running',
  '{count} 个已打开': '{count} open',
  '在文件管理器中显示失败: {error}': 'Could not reveal in File Explorer: {error}',
  '重命名失败: {error}': 'Could not rename: {error}',
  '关闭文件': 'Close File',
  '关闭右侧': 'Close to the Right',
  '在资源管理器中定位': 'Locate in Explorer',
  '新终端配置': 'New Terminal Profile',
  '默认启动配置': 'Default Startup Profile',
  '可不选；未指定时使用内置普通 PowerShell 终端。': 'Optional. Uses the built-in PowerShell terminal when no profile is selected.',
  '未指定（内置默认）': 'Not selected (built-in default)',
  '终端配置': 'Terminal Profiles',
  '新增配置': 'Add Profile',
  '配置名称': 'Profile name',
  '删除{value}': 'Delete {value}',
  '启动命令': 'Startup command',
  '留空：启动 PowerShell': 'Leave empty to start PowerShell',
  '例如：opencode': 'e.g. opencode',
  '{name}启动命令': '{name} startup command',
  '点击 + 使用默认配置；右键 + 可选择其它配置。启动命令留空时启动 PowerShell；程序（如 opencode）可通过窗口标题自动重命名标签，也可双击标签手动修改。':
    'Click + for the default profile; right-click + to choose another profile. An empty startup command starts PowerShell. Programs such as opencode can rename the tab from the window title, or you can double-click a tab to rename it manually.',
  '路径': 'Path',
  '最近打开': 'Last Opened',
  '创建时间': 'Created',
  '刚刚': 'Just now',
  '{count} 分钟前': '{count} minute(s) ago',
  '{count} 小时前': '{count} hour(s) ago',
  '{count} 天前': '{count} day(s) ago',
  '批量删除项目': 'Delete Projects',
  '确定永久删除选中的 {count} 个项目？': 'Permanently delete the selected {count} project(s)?',
  '将移除工作区记录并关闭相关终端与标签页，不会删除磁盘上的项目文件。':
    'This removes workspace records and closes related terminals and tabs. Files on disk are not deleted.',
  '删除「{name}」失败: {error}': 'Could not delete “{name}”: {error}',
  '共 {total} 个 · 显示 {visible} · 隐藏 {hidden}': '{total} total · {visible} visible · {hidden} hidden',
  '添加文件夹': 'Add Folder',
  '全部': 'All',
  '已显示': 'Visible',
  '已隐藏': 'Hidden',
  '排序': 'Sort',
  '切换排序方向': 'Toggle sort direction',
  '已选 {count} 项': '{count} selected',
  '批量删除': 'Delete Selected',
  '取消选择': 'Clear Selection',
  '暂无项目。点击上方按钮添加。': 'No projects yet. Use the buttons above to add one.',
  '全选当前列表': 'Select all in the current list',
  '操作': 'Actions',
  '选择 {name}': 'Select {name}',
  '恢复显示': 'Show in Title Bar',
  '重新定位': 'Relocate',
  '顶栏 ✕ 仅隐藏显示；此处「永久删除」才会清除项目记录':
    'The ✕ in the title bar only hides a project; only “Delete Permanently” here removes its record.',
  '完成': 'Done',
  '未保存的更改': 'Unsaved Changes',
  ' 等 {count} 个文件': ' and {count} more files',
  '{names}{remainder} 尚未保存': '{names}{remainder} have unsaved changes',
  '{action}会丢失这些更改，且无法撤销。': '{action} will discard these changes and cannot be undone.',
  '放弃更改': 'Discard Changes',
  '退出 QingCode': 'Quit QingCode',
  '确定要关闭应用程序吗？': 'Are you sure you want to close the application?',
  '退出': 'Quit',
  '退出应用': 'Quit Application',
  '{count} 个终端仍在运行，退出后将终止。\n未保存的编辑器更改可能丢失。':
    '{count} terminal(s) are still running and will be terminated when you quit.\nUnsaved editor changes may be lost.',
  '未保存的编辑器更改可能丢失。': 'Unsaved editor changes may be lost.',
  '关闭窗口失败: {error}': 'Could not close window: {error}',
  '窗口最大化失败: {error}': 'Could not maximize window: {error}',
  '窗口最小化失败: {error}': 'Could not minimize window: {error}',
  '新建文件夹名称': 'New folder name',
  '新建文件名称': 'New file name',
  '移除项目': 'Remove Project',
  '确定从工作区移除「{name}」？': 'Remove “{name}” from the workspace?',
  '该项目有 {count} 个运行中的终端，移除后将被终止。\n不会删除磁盘上的项目文件。':
    'This project has {count} running terminal(s), which will be terminated when it is removed.\nFiles on disk will not be deleted.',
  '不会删除磁盘上的项目文件。': 'Files on disk will not be deleted.',
  '移除': 'Remove',
  '移除项目失败: {error}': 'Could not remove project: {error}',
  '重新定位项目失败: {error}': 'Could not relocate project: {error}',
  '项目名称': 'Project name',
  '终端项目': 'Terminal Project',
  '新建': 'Create',
  '名称不能为空': 'Name cannot be empty',
  '名称不能包含 \\ / : * ? " < > |': 'Name cannot contain \\ / : * ? " < > |',
  '该名称不可用': 'This name is not available',
}

function format(text: string, values?: Values) {
  if (!values) return text
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}

function readLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY)
    if (stored === 'zh-CN' || stored === 'en') return stored
  } catch {}
  return DEFAULT_LANGUAGE
}

function applyLanguage(language: AppLanguage) {
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

type LocaleState = {
  language: AppLanguage
  setLanguage: (language: AppLanguage) => void
}

export const useLocaleStore = create<LocaleState>(set => ({
  language: readLanguage(),
  setLanguage: language => {
    try {
      localStorage.setItem(LANGUAGE_KEY, language)
    } catch {}
    applyLanguage(language)
    set({ language })
  },
}))

export function initializeLanguage() {
  applyLanguage(useLocaleStore.getState().language)
}

export function translateFor(language: AppLanguage, source: string, values?: Values) {
  return format(language === 'en' ? english[source] ?? source : source, values)
}

/** Translate UI text in React components and rerender when the language changes. */
export function useI18n() {
  const language = useLocaleStore(state => state.language)
  const setLanguage = useLocaleStore(state => state.setLanguage)
  return {
    language,
    setLanguage,
    t: (source: string, values?: Values) => translateFor(language, source, values),
  }
}

/** Translate interaction feedback emitted outside React render functions. */
export function translate(source: string, values?: Values) {
  return translateFor(useLocaleStore.getState().language, source, values)
}
