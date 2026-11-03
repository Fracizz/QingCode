import type { SettingsCategoryId } from '../components/SettingsLayout'

type Translate = (source: string) => string

type SearchGroup = { category: SettingsCategoryId; terms: string[]; userOnly?: boolean }

// Section navigation and individual rows share aliases and configuration keys.
const groups: SearchGroup[] = [
  { category: 'common', terms: ['颜色主题', '外观', '深色', '浅色', '橄榄绿', 'theme', 'color theme'] },
  { category: 'common', terms: ['界面字号', 'interfaceFontSize', 'UI font size'] },
  { category: 'editor', terms: ['参考线', '缩进线', '括号线', 'editor.guides.enabled', 'guides'] },
  { category: 'editor', terms: ['小地图', 'minimap', 'editor.minimap.enabled'] },
  { category: 'editor', terms: ['自动保存', 'files.autoSave', 'files.autoSaveDelay', 'auto save'] },
  { category: 'editor', terms: ['界面字体', '代码字体', '编辑器字号', 'editor.fontSize', 'editor.fontFamily', '字体', 'font'] },
  { category: 'terminal', terms: ['终端字体', '终端 › 集成: 字体族', '终端字号', 'terminal.integrated.fontFamily', 'terminal.integrated.fontSize'] },
  { category: 'terminal', terms: ['默认启动配置', '终端配置', '默认 Shell', '终端 › 集成: 默认 Shell', 'pwsh', 'WSL', 'Zsh'] },
  { category: 'terminal', terms: ['SSH', '粘贴', '上传', 'terminal-paste', 'sshUploadOnPaste', 'terminal.integrated.sshUploadOnPaste', '清理远程粘贴文件'] },
  { category: 'ai', terms: ['AI', 'CLI', 'skills', 'Agent', 'qingcode-cli', 'AI CLI skills'], userOnly: true },
  { category: 'features', terms: ['远程连接', 'SSH 连接'] },
  { category: 'features', terms: ['SSH 服务', '远端服务', '自动下载', '离线目录', 'ssh.server.enabled', 'ssh.server.autoDownload', 'ssh.server.offlineDir'] },
  { category: 'features', terms: ['会话状态', '会话状态保存', '会话', 'session', 'qingcode.session.persist'], userOnly: true },
  { category: 'features', terms: ['项目会话 LRU', '编辑器状态缓存', '会话', 'LRU', 'qingcode.session.editorStateCacheSize'], userOnly: true },
  { category: 'features', terms: ['项目角标', '顶栏项目角标', '项目指示', 'qingcode.projectIndicators.enabled'], userOnly: true },
  { category: 'features', terms: ['Git 随机刷新周期起始值', 'Git 刷新周期起始值', 'Git', '刷新', '分钟', 'qingcode.git.refreshIntervalStartMinutes'], userOnly: true },
  { category: 'features', terms: ['检查更新', '自动检查更新', '更新', 'qingcode.update.checkOnStartup'], userOnly: true },
  { category: 'features', terms: ['打开方式', 'Open with', 'Windows'], userOnly: true },
  { category: 'features', terms: ['快捷键', '键盘', '打开搜索', '显示或隐藏终端', '切换小地图', '复制路径', '文件引用', 'Alt+C', 'Ctrl+Shift+C', 'Ctrl+Shift+G', 'Ctrl+Shift+O', 'Shift+Alt+F', '格式化', '转到编辑器中的符号', '符号', 'shortcuts'], userOnly: true },
  { category: 'language', terms: ['语言', '简体中文', 'English', '语言包', '自定义语言', 'language'] },
  { category: 'about', terms: ['关于', '版本', 'git', '仓库', 'Gitee', 'GitHub', '开源', 'License', 'MIT'], userOnly: true },
  { category: 'json', terms: ['打开设置 JSON', 'settings.json', '自定义设置', 'files.exclude', 'search.exclude', '不计划', 'JSON5', 'files.encoding', 'files.eol', 'editor.tabSize', 'editor.wordWrap'] },
]

const categories: Record<SettingsCategoryId, string> = {
  common: '常用设置', editor: '文本编辑器', terminal: '终端', ai: 'AI',
  features: '功能', language: '语言', about: '关于', json: '打开设置 JSON',
}

function includesQuery(query: string, terms: string[], t: Translate) {
  return terms.some(term => term.toLowerCase().includes(query) || t(term).toLowerCase().includes(query))
}

export function matchesSettingsCategory(category: SettingsCategoryId, query: string, workspace: boolean, t: Translate) {
  const available = groups.filter(group => group.category === category && !(workspace && group.userOnly))
  return available.length > 0 && (!query || includesQuery(query, [categories[category], ...available.flatMap(group => group.terms)], t))
}

export function matchesSettingsTerms(query: string, terms: string[], workspace: boolean, t: Translate) {
  if (!query) return true
  const associated = groups.filter(group => !(workspace && group.userOnly) && group.terms.some(term => terms.includes(term)))
  return includesQuery(query, [...terms, ...associated.flatMap(group => [...group.terms, categories[group.category]])], t)
}
