import { SHORTCUT_SEARCH_TERMS } from './shortcutSettings'

export type SettingsCategoryId = 'appearance' | 'editor' | 'terminal' | 'projects' | 'remote' | 'gitPushSync' | 'mobile' | 'tools' | 'shortcuts' | 'about'

/** Navigation order and search category titles share this registry. */
export const SETTINGS_CATEGORIES: { id: SettingsCategoryId; label: string }[] = [
  { id: 'appearance', label: '外观与语言' },
  { id: 'editor', label: '编辑器与文件' },
  { id: 'terminal', label: '终端' },
  { id: 'projects', label: '项目与会话' },
  { id: 'remote', label: '远程连接' },
  { id: 'gitPushSync', label: 'Git 多端同步' },
  { id: 'mobile', label: '移动连接' },
  { id: 'tools', label: '工具与集成' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'about', label: '更新与关于' },
]

type Translate = (source: string) => string

type SearchGroup = { category: SettingsCategoryId; terms: string[]; userOnly?: boolean; windowsOnly?: boolean }

// Section navigation and individual rows share aliases and configuration keys.
const groups: SearchGroup[] = [
  { category: 'appearance', terms: ['颜色主题', '外观', '深色', '浅色', '橄榄绿', 'theme', 'color theme'], userOnly: true },
  { category: 'appearance', terms: ['界面字号', 'interfaceFontSize', 'UI font size'], userOnly: true },
  { category: 'editor', terms: ['参考线', '编辑器: 参考线', '缩进线', '括号线', 'editor.guides.enabled', 'guides'] },
  { category: 'editor', terms: ['小地图', '编辑器: 小地图', 'minimap', 'editor.minimap.enabled'] },
  { category: 'editor', terms: ['自动保存', '文件: 自动保存', '文件: 自动保存延迟', 'files.autoSave', 'files.autoSaveDelay', 'auto save'] },
  { category: 'appearance', terms: ['界面字体', 'interfaceFont', '界面', 'UI font family'], userOnly: true },
  { category: 'editor', terms: ['代码字体', '编辑器: 字体族', '编辑器: 字号', '编辑器字号', 'editor.fontSize', 'editor.fontFamily', '字体', 'font'], userOnly: true },
  { category: 'terminal', terms: ['终端字体', '终端 › 集成: 字体族', '终端字号', '终端 › 集成: 字号', 'terminal.integrated.fontFamily', 'terminal.integrated.fontSize'], userOnly: true },
  { category: 'terminal', terms: ['默认启动配置', '终端配置', '默认 Shell', '终端 › 集成: 默认 Shell', 'pwsh', 'WSL', 'Zsh'], userOnly: true },
  { category: 'terminal', terms: ['SSH', '粘贴', '上传', 'terminal-paste', 'sshUploadOnPaste', '终端 › 集成: SSH 粘贴上传', 'terminal.integrated.sshUploadOnPaste', '清理远程粘贴文件'] },
  { category: 'terminal', terms: ['粘贴', '大段', '文件', 'largePasteAsFile', '终端 › 集成: 大段粘贴存为文件', 'terminal.integrated.largePasteAsFile'] },
  { category: 'terminal', terms: ['持久', '接回', '保留', '本地终端', 'persistLocalSessions', '终端 › 集成: 本地终端可接回', 'terminal.integrated.persistLocalSessions'] },
  { category: 'terminal', terms: ['状态', '运行中', 'tabActivityIndicator', '终端 › 集成: 标签运行状态', 'terminal.integrated.tabActivityIndicator'] },
  { category: 'terminal', terms: ['Shift+Enter', '换行', 'Agent', 'shiftEnterNewline', '终端 › 集成: Shift+Enter 换行', 'terminal.integrated.shiftEnterNewline'] },
  { category: 'tools', terms: ['AI', 'CLI', 'skills', 'Agent', 'qingcode-cli', 'AI CLI skills'], userOnly: true },
  { category: 'remote', terms: ['远程连接', 'SSH 连接'], userOnly: true },
  { category: 'remote', terms: ['SSH 服务', 'SSH › 服务: 缺失时自动下载', 'SSH › 服务: 离线目录', '远端服务', '自动下载', '离线目录', 'ssh.server.enabled', 'ssh.server.autoDownload', 'ssh.server.offlineDir'] },
  { category: 'projects', terms: ['会话状态', '会话状态保存', '会话', 'session', 'qingcode.session.persist'], userOnly: true },
  { category: 'projects', terms: ['项目会话 LRU', '项目会话 LRU 个数', '项目会话 LRU 自定义个数', '编辑器状态缓存', '会话', 'LRU', 'qingcode.session.editorStateCacheSize'], userOnly: true },
  { category: 'projects', terms: ['项目角标', '顶栏项目角标', '项目指示', 'qingcode.projectIndicators.enabled'], userOnly: true },
  { category: 'projects', terms: ['Git 随机刷新周期起始值', 'Git 随机刷新周期起始值（分钟）', 'Git 刷新周期起始值', 'Git', '刷新', '分钟', 'qingcode.git.refreshIntervalStartMinutes'], userOnly: true },
  { category: 'about', terms: ['检查更新', '启动时自动检查更新', '自动检查更新', '更新', 'qingcode.update.checkOnStartup'], userOnly: true },
  { category: 'tools', terms: ['打开方式', 'Windows 打开方式', 'Open with', 'Windows'], userOnly: true, windowsOnly: true },
  { category: 'shortcuts', terms: SHORTCUT_SEARCH_TERMS, userOnly: true },
  { category: 'gitPushSync', terms: ['Git 多端同步', '自动同步', '自动拉取', '快进', '推送', 'git push', 'auto pull', 'sync'], userOnly: true },
  { category: 'mobile', terms: ['Android', '安卓', '移动连接', '手机', '配对', '二维码', '端口', '密码', '验证码', '证书指纹', '局域网', 'Tailscale', 'mobile', 'pairing'], userOnly: true, windowsOnly: true },
  { category: 'appearance', terms: ['语言', '显示语言', '自定义语言包', '简体中文', 'English', '语言包', '自定义语言', 'language'], userOnly: true },
  { category: 'about', terms: ['关于', 'QingCode', '版本', '版本未知', '源代码仓库', '协议', 'git', '仓库', 'Gitee', 'GitHub', '开源', 'License', 'MIT'], userOnly: true },
  { category: 'editor', terms: ['打开设置 JSON', 'JSON 键生效说明', 'default-settings.json', 'project-settings.json', 'settings.json', '自定义设置', 'files.exclude', 'search.exclude', '不计划', 'JSON5', 'files.encoding', 'files.eol', 'editor.tabSize', 'editor.wordWrap'] },
]

const categories = Object.fromEntries(SETTINGS_CATEGORIES.map(category => [category.id, category.label])) as Record<SettingsCategoryId, string>
const categoryAliases: Partial<Record<SettingsCategoryId, string[]>> = {
  appearance: ['常用设置', '外观', '语言'],
  editor: ['文本编辑器'],
  tools: ['AI'],
  about: ['关于'],
}

function availableGroups(workspace: boolean, windows: boolean) {
  return groups.filter(group => !(workspace && group.userOnly) && !(group.windowsOnly && !windows))
}

function includesQuery(query: string, terms: string[], t: Translate) {
  return terms.some(term => term.toLowerCase().includes(query) || t(term).toLowerCase().includes(query))
}

export function matchesSettingsCategory(category: SettingsCategoryId, query: string, workspace: boolean, t: Translate, windows = true) {
  const available = availableGroups(workspace, windows).filter(group => group.category === category)
  return available.length > 0 && (!query || includesQuery(query, [categories[category], ...(categoryAliases[category] ?? []), ...available.flatMap(group => group.terms)], t))
}

export function matchesSettingsTerms(query: string, terms: string[], workspace: boolean, t: Translate, windows = true) {
  if (!query) return true
  const associated = availableGroups(workspace, windows).filter(group => group.terms.some(term => terms.includes(term)))
  return includesQuery(query, [...terms, ...associated.flatMap(group => [...group.terms, categories[group.category], ...(categoryAliases[group.category] ?? [])])], t)
}
