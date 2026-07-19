import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import {
  CircleHelp,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { useI18n } from '../lib/i18n'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SETTINGS_EVENT,
  FONT_SIZE_OPTIONS,
  INTERFACE_FONT_OPTIONS,
  MONO_FONT_OPTIONS,
  loadFontSettings,
  saveFontSettings,
  type FontSettings,
} from '../lib/fontSettings'
import FontFamilySelect from './FontFamilySelect'
import SettingSelect from './SettingSelect'
import {
  DEFAULT_THEME,
  THEMES,
  loadTheme,
  saveTheme,
  type AppTheme,
} from '../lib/themeSettings'
import {
  DEFAULT_TERMINAL_PROFILE,
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  type TerminalProfileSettings,
} from '../lib/terminalProfiles'
import {
  availableTerminalShells,
  defaultTerminalShell,
  terminalShellLabelKey,
  type TerminalShellId,
} from '../lib/terminalShell'
import { useShortcutStore } from '../store/shortcutStore'
import { DEFAULT_SHORTCUTS, type ShortcutCommand } from '../lib/shortcuts'
import ShortcutSettings from './ShortcutSettings'
import HelpDialog from './HelpDialog'
import SegmentedControl from './SegmentedControl'
import Tooltip from './Tooltip'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import {
  ensureSettingsFile,
  resolveGlobalSettingsPath,
  resolveProjectSettingsPath,
  DEFAULT_GLOBAL_SETTINGS,
} from '../lib/projectSettings'
import {
  AUTO_SAVE_DELAY_OPTIONS,
  AUTO_SAVE_MODES,
  loadScopedAutoSaveSettings,
  saveScopedAutoSaveSettings,
  type AutoSaveMode,
} from '../lib/autoSaveSettings'
import { isTauri, safeInvoke } from '../lib/tauri'
import {
  getOpenWithStatus,
  registerOpenWith,
  unregisterOpenWith,
  type OpenWithStatus,
} from '../lib/openWithSettings'
import {
  getMinimapEnabled,
  loadScopedMinimapEnabled,
  saveScopedMinimapEnabled,
} from '../lib/minimapSettings'
import {
  DEFAULT_UPDATE_SETTINGS,
  loadUpdateSettings,
  saveCheckOnStartup,
} from '../lib/updateSettings'
import { checkForAppUpdate, promptAppUpdate } from '../lib/appUpdate'

type SettingsScope = 'user' | 'workspace'
type CategoryId =
  | 'common'
  | 'appearance'
  | 'editor'
  | 'terminal'
  | 'features'
  | 'language'
  | 'json'

/** Survives Strict Mode remounts so a stale deep-link is not reapplied. */
let appliedSettingsFocusSignal = 0

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'common', label: '常用设置' },
  { id: 'appearance', label: '外观' },
  { id: 'editor', label: '文本编辑器' },
  { id: 'terminal', label: '终端' },
  { id: 'features', label: '功能' },
  { id: 'language', label: '语言' },
  { id: 'json', label: '打开设置 JSON' },
]

export default function SettingsEditor() {
  const { t, language, setLanguage, localeOptions, reloadUserLocales } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const pushToast = useProjectStore(s => s.pushToast)
  const openFile = useEditorStore(s => s.openFile)
  const setView = useUIStore(s => s.setView)
  const settingsFocusQuery = useUIStore(s => s.settingsFocusQuery)
  const settingsFocusSignal = useUIStore(s => s.settingsFocusSignal)
  const shortcuts = useShortcutStore(s => s.shortcuts)

  const [scope, setScope] = useState<SettingsScope>('user')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryId>('common')
  const [helpOpen, setHelpOpen] = useState(false)
  const [theme, setThemeState] = useState<AppTheme>(loadTheme)
  const [fonts, setFonts] = useState<FontSettings>(loadFontSettings)
  const [terminal, setTerminal] = useState<TerminalProfileSettings>(loadTerminalProfileSettings)
  const [openingJson, setOpeningJson] = useState(false)
  const [autoSaveMode, setAutoSaveMode] = useState<AutoSaveMode>('off')
  const [autoSaveDelay, setAutoSaveDelay] = useState<number>(
    DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay'] as number,
  )
  const [minimapEnabled, setMinimapEnabled] = useState(getMinimapEnabled)
  const [openWith, setOpenWith] = useState<OpenWithStatus | null>(null)
  const [openWithBusy, setOpenWithBusy] = useState(false)
  const [checkOnStartup, setCheckOnStartup] = useState(DEFAULT_UPDATE_SETTINGS.checkOnStartup)
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const sectionRefs = useRef<Partial<Record<CategoryId, HTMLElement | null>>>({})

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    void getOpenWithStatus().then(setOpenWith)
  }, [])

  useEffect(() => {
    void loadUpdateSettings().then(settings => setCheckOnStartup(settings.checkOnStartup))
  }, [])

  useEffect(() => {
    const onFonts = () => setFonts(loadFontSettings())
    window.addEventListener(FONT_SETTINGS_EVENT, onFonts)
    return () => window.removeEventListener(FONT_SETTINGS_EVENT, onFonts)
  }, [])

  useEffect(() => {
    if (settingsFocusSignal === 0 || settingsFocusSignal <= appliedSettingsFocusSignal) return
    appliedSettingsFocusSignal = settingsFocusSignal
    setScope('user')
    if (settingsFocusQuery) {
      setQuery(settingsFocusQuery)
      setCategory('editor')
    }
    requestAnimationFrame(() => {
      sectionRefs.current.editor?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      searchRef.current?.focus()
    })
  }, [settingsFocusSignal, settingsFocusQuery])

  useEffect(() => {
    if (scope === 'workspace' && !currentProject) setScope('user')
  }, [scope, currentProject])

  useEffect(() => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    void loadScopedAutoSaveSettings(settingsScope, currentProject).then(settings => {
      setAutoSaveMode(settings.mode)
      setAutoSaveDelay(settings.delay)
    })
    void loadScopedMinimapEnabled(settingsScope, currentProject).then(setMinimapEnabled)
  }, [scope, currentProject])

  const workspaceLocked = scope === 'workspace'
  const q = query.trim().toLowerCase()

  const match = (...texts: string[]) => {
    if (!q) return true
    return texts.some(text => t(text).toLowerCase().includes(q) || text.toLowerCase().includes(q))
  }

  const updateTheme = (value: AppTheme) => {
    setThemeState(value)
    saveTheme(value)
  }

  const updateFonts = <K extends keyof FontSettings>(key: K, value: FontSettings[K]) => {
    const next = { ...fonts, [key]: value }
    setFonts(next)
    saveFontSettings(next)
  }

  const updateTerminal = (next: TerminalProfileSettings) => {
    setTerminal(next)
    saveTerminalProfileSettings(next)
  }

  const updateAutoSave = async (mode: AutoSaveMode, delay = autoSaveDelay) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setAutoSaveMode(mode)
    setAutoSaveDelay(delay)
    try {
      await saveScopedAutoSaveSettings(settingsScope, { mode, delay }, currentProject)
    } catch (error) {
      pushToast('error', t('保存自动保存设置失败: {error}', { error: String(error) }))
    }
  }

  const updateMinimapEnabled = async (enabled: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setMinimapEnabled(enabled)
    try {
      await saveScopedMinimapEnabled(settingsScope, enabled, currentProject)
    } catch (error) {
      pushToast('error', t('保存小地图设置失败: {error}', { error: String(error) }))
    }
  }

  const scrollTo = (id: CategoryId) => {
    setCategory(id)
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const openSettingsJson = async (writeDefaults = false) => {
    if (!isTauri()) {
      pushToast('error', t('当前环境无法打开设置文件'))
      return
    }
    if (scope === 'workspace' && !currentProject) {
      pushToast('error', t('请先选择项目，再配置项目设置。'))
      return
    }
    setOpeningJson(true)
    try {
      const path =
        scope === 'user'
          ? await resolveGlobalSettingsPath()
          : await resolveProjectSettingsPath(currentProject!)
      // Always prefer the commented JSON5 template for missing / bare default files.
      await ensureSettingsFile(path, {
        scope: scope === 'user' ? 'global' : 'project',
        writeTemplate: writeDefaults,
        upgradeComments: true,
      })
      await openFile(path)
      setView('explorer')
      pushToast(
        'success',
        writeDefaults ? t('已写入默认模板并在编辑器中打开') : t('已在编辑器中打开设置文件'),
      )
    } catch (reason) {
      pushToast('error', t('打开设置失败: {error}', { error: String(reason) }))
    } finally {
      setOpeningJson(false)
    }
  }

  const visibleCategories = useMemo(() => {
    if (!q) return CATEGORIES
    return CATEGORIES.filter(cat => {
      if (cat.id === 'json') {
        return match(
          '打开设置 JSON',
          'settings.json',
          '自定义设置',
          'files.exclude',
          'search.exclude',
          '不计划',
        )
      }
      if (cat.id === 'common') {
        return match('颜色主题', '界面字号', '常用设置')
      }
      if (cat.id === 'appearance') return match('颜色主题', '外观', '深色', '浅色')
      if (cat.id === 'editor')
        return match(
          '界面字体',
          '代码字体',
          '编辑器字号',
          '文本编辑器',
          '自动保存',
          '小地图',
          'minimap',
        )
      if (cat.id === 'terminal') return match('终端', '默认启动配置', '终端字号', '默认 Shell', 'pwsh', 'WSL', 'Zsh')
      if (cat.id === 'features') {
        return match(
          '快捷键',
          '功能',
          '打开搜索',
          '切换终端',
          '切换小地图',
          '复制路径',
          '文件引用',
          '打开方式',
          'Open with',
          'Windows',
          '检查更新',
          '自动检查更新',
          'Alt+C',
          'Ctrl+Shift+C',
          'Ctrl+Shift+G',
          'Ctrl+Shift+O',
          'Shift+Alt+F',
          '格式化',
          '转到编辑器中的符号',
          '符号',
        )
      }
      if (cat.id === 'language') {
        return match('语言', '简体中文', 'English', '语言包', '自定义语言')
      }
      return true
    })
  }, [q, language, shortcuts])

  return (
    <div className="ui-font-scaled h-full flex flex-col bg-bg text-fg min-w-0">
      {/* Tab strip like VS Code */}
      <div className="flex-shrink-0 h-[var(--tab-height)] flex items-stretch border-b border-border bg-bg-sidebar">
        <div className="flex items-center gap-2 px-3 border-r border-border bg-bg min-w-0">
          <Settings2 size={14} className="text-fg-muted flex-shrink-0" />
          <span className="text-[13px] truncate">{t('设置')}</span>
        </div>
      </div>

      {/* Header: scope + search + actions */}
      <div className="flex-shrink-0 border-b border-border bg-bg pt-3 pb-3">
        <div className="flex items-center gap-2 mb-3 px-4">
          <SegmentedControl
            ariaLabel={t('设置范围')}
            options={[
              { value: 'user', label: t('用户') },
              { value: 'workspace', label: t('工作区'), disabled: !currentProject },
            ]}
            value={scope}
            onChange={value => {
              if (value === 'workspace' && !currentProject) return
              setScope(value)
            }}
          />
          <div className="flex-1" />
          <Tooltip label={t('帮助文档')} side="bottom">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
              aria-label={t('帮助文档')}
            >
              <CircleHelp size={15} />
            </button>
          </Tooltip>
        </div>

        {/* Search aligns with the content column (TOC is 200px; content uses px-6 + max-w-[800px]). */}
        <div className="flex min-w-0">
          <div className="w-[200px] flex-shrink-0" aria-hidden />
          <div className="flex-1 min-w-0 px-6">
            <div className="relative max-w-[800px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim" />
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('搜索设置')}
                className="setting-input w-full h-8 pl-8 pr-8 text-[13px]"
              />
              {query && (
                <button
                  type="button"
                  aria-label={t('清除搜索')}
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {scope === 'workspace' && (
              <p className="mt-2 text-[12px] text-fg-muted max-w-[800px]">
                {t('工作区设置作用于当前项目「{name}」。多数界面设置仅用户作用域可用；工作区主要用于 project-settings.json。', {
                  name: currentProject?.name ?? '',
                })}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* TOC */}
        <nav className="w-[200px] flex-shrink-0 border-r border-border overflow-auto py-2 bg-bg">
          {visibleCategories.map(cat => (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                if (cat.id === 'json') {
                  void openSettingsJson(false)
                  return
                }
                scrollTo(cat.id)
              }}
              className={`block w-full px-4 py-1.5 text-left text-[13px] truncate transition-colors ${
                category === cat.id
                  ? 'bg-bg-active text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
            >
              {t(cat.label)}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-auto px-6 py-4">
          <div className="max-w-[800px] flex flex-col gap-6">
            {match('常用设置', '颜色主题', '界面字号') && (
              <Section
                id="common"
                title={t('常用设置')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                {match('颜色主题', '外观') && (
                  <SettingItem
                    title={t('颜色主题')}
                    description={t('指定 QingCode 使用的颜色主题。选择“跟随系统”时随操作系统明暗切换。')}
                    modified={theme !== DEFAULT_THEME}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <SettingSelect
                      value={theme}
                      disabled={workspaceLocked}
                      aria-label={t('颜色主题')}
                      onChange={next => updateTheme(next as AppTheme)}
                      options={THEMES.map(option => ({
                        value: option.value,
                        label: t(option.label),
                      }))}
                    />
                  </SettingItem>
                )}
                {match('界面字号', '字体') && (
                  <SettingItem
                    title={t('界面字号')}
                    description={t('控制菜单、标题栏、侧栏、标签和状态栏的字号（像素）。')}
                    modified={fonts.interfaceFontSize !== DEFAULT_FONT_SETTINGS.interfaceFontSize}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <SettingSelect
                      value={String(fonts.interfaceFontSize)}
                      disabled={workspaceLocked}
                      aria-label={t('界面字号')}
                      onChange={next => updateFonts('interfaceFontSize', Number(next))}
                      options={FONT_SIZE_OPTIONS.map(size => ({
                        value: String(size),
                        label: String(size),
                      }))}
                    />
                  </SettingItem>
                )}
              </Section>
            )}

            {match('外观', '颜色主题') && (
              <Section
                id="appearance"
                title={t('外观')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                <SettingItem
                  title={t('颜色主题')}
                  description={t('指定 QingCode 使用的颜色主题。')}
                  modified={theme !== DEFAULT_THEME}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <SettingSelect
                    value={theme}
                    disabled={workspaceLocked}
                    aria-label={t('颜色主题')}
                    onChange={next => updateTheme(next as AppTheme)}
                    options={THEMES.map(option => ({
                      value: option.value,
                      label: t(option.label),
                    }))}
                  />
                </SettingItem>
              </Section>
            )}

            {match(
              '文本编辑器',
              '界面字体',
              '代码字体',
              '编辑器字号',
              '终端字号',
              '自动保存',
              '小地图',
              'minimap',
            ) && (
              <Section
                id="editor"
                title={t('文本编辑器')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                {match('小地图', 'minimap', 'editor.minimap.enabled') && (
                  <SettingItem
                    title={t('编辑器: 小地图')}
                    description={t(
                      '在编辑区右侧显示代码缩略图，便于快速跳转。大于 5MB 的文件会自动隐藏。',
                    )}
                    modified={minimapEnabled !== DEFAULT_GLOBAL_SETTINGS['editor.minimap.enabled']}
                    locked={scope === 'workspace' && !currentProject}
                    lockHint={t('请先选择项目，再配置工作区小地图。')}
                  >
                    <select
                      value={minimapEnabled ? 'on' : 'off'}
                      disabled={scope === 'workspace' && !currentProject}
                      onChange={e => void updateMinimapEnabled(e.target.value === 'on')}
                      className="setting-control setting-select"
                      aria-label={t('编辑器: 小地图')}
                    >
                      <option value="on">{t('开启')}</option>
                      <option value="off">{t('关闭')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('自动保存', 'files.autoSave') && (
                  <>
                    <SettingItem
                      title={t('文件: 自动保存')}
                      description={t('控制具有未保存更改的编辑器何时自动保存。')}
                      modified={
                        autoSaveMode !== DEFAULT_GLOBAL_SETTINGS['files.autoSave'] ||
                        autoSaveDelay !== DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay']
                      }
                      locked={scope === 'workspace' && !currentProject}
                      lockHint={t('请先选择项目，再配置工作区自动保存。')}
                    >
                      <select
                        value={autoSaveMode}
                        disabled={scope === 'workspace' && !currentProject}
                        onChange={e => void updateAutoSave(e.target.value as AutoSaveMode)}
                        className="setting-control setting-control-wide setting-select"
                      >
                        {AUTO_SAVE_MODES.map(option => (
                          <option key={option.value} value={option.value}>
                            {t(option.label)}
                          </option>
                        ))}
                      </select>
                    </SettingItem>
                    {autoSaveMode === 'afterDelay' && (
                      <SettingItem
                        title={t('文件: 自动保存延迟')}
                        description={t('在 afterDelay 模式下，停止编辑后等待多久再保存（毫秒）。')}
                        modified={autoSaveDelay !== DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay']}
                        locked={scope === 'workspace' && !currentProject}
                        lockHint={t('请先选择项目，再配置工作区自动保存。')}
                      >
                        <select
                          value={autoSaveDelay}
                          disabled={scope === 'workspace' && !currentProject}
                          onChange={e =>
                            void updateAutoSave(autoSaveMode, Number(e.target.value))
                          }
                          className="setting-control setting-select"
                        >
                          {AUTO_SAVE_DELAY_OPTIONS.map(delay => (
                            <option key={delay} value={delay}>
                              {delay} ms
                            </option>
                          ))}
                        </select>
                      </SettingItem>
                    )}
                  </>
                )}
                {match('界面字体', '代码字体', '编辑器字号') && (
                <>
                <SettingItem
                  title={t('界面字体')}
                  description={t('用于菜单、标题栏、侧栏、标签和状态栏的字体族。可选择本机已安装字体。')}
                  modified={fonts.interfaceFont !== DEFAULT_FONT_SETTINGS.interfaceFont}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <FontFamilySelect
                    value={fonts.interfaceFont}
                    presets={INTERFACE_FONT_OPTIONS}
                    kind="sans"
                    disabled={workspaceLocked}
                    aria-label={t('界面字体')}
                    onChange={value => updateFonts('interfaceFont', value)}
                  />
                </SettingItem>
                <SettingItem
                  title={t('编辑器: 字体族')}
                  description={t('控制编辑器字体族。终端默认共用同一等宽字体。可选择本机已安装字体。')}
                  modified={fonts.monoFont !== DEFAULT_FONT_SETTINGS.monoFont}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <FontFamilySelect
                    value={fonts.monoFont}
                    presets={MONO_FONT_OPTIONS}
                    kind="mono"
                    disabled={workspaceLocked}
                    aria-label={t('编辑器: 字体族')}
                    onChange={value => updateFonts('monoFont', value)}
                  />
                </SettingItem>
                <SettingItem
                  title={t('编辑器: 字号')}
                  description={t('控制编辑器中的字号（像素），对应用户设置 editor.fontSize。')}
                  modified={fonts.editorFontSize !== DEFAULT_FONT_SETTINGS.editorFontSize}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={fonts.editorFontSize}
                    disabled={workspaceLocked}
                    onChange={e => updateFonts('editorFontSize', Number(e.target.value))}
                    className="setting-control setting-select"
                  >
                    {FONT_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </SettingItem>
                </>
                )}
              </Section>
            )}

            {match('终端', '默认启动配置', '终端字号', '默认 Shell', 'pwsh', 'WSL', 'Zsh') && (
              <Section
                id="terminal"
                title={t('终端')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                <SettingItem
                  title={t('终端 › 集成: 字号')}
                  description={t('控制终端的字号（像素）。')}
                  modified={fonts.terminalFontSize !== DEFAULT_FONT_SETTINGS.terminalFontSize}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={fonts.terminalFontSize}
                    disabled={workspaceLocked}
                    onChange={e => updateFonts('terminalFontSize', Number(e.target.value))}
                    className="setting-control setting-select"
                  >
                    {FONT_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </SettingItem>
                <SettingItem
                  title={t('终端 › 集成: 默认 Shell')}
                  description={t(
                    '新建「普通终端」时使用的主机 Shell（全局）。Windows 默认 PowerShell 7 (pwsh)，可选 cmd / WSL；macOS/Linux 默认 Zsh，可选 Bash / pwsh。自定义配置可单独指定 Shell。',
                  )}
                  modified={terminal.defaultShell !== defaultTerminalShell()}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <SettingSelect
                    value={terminal.defaultShell}
                    disabled={workspaceLocked}
                    className="setting-control-wide"
                    aria-label={t('终端 › 集成: 默认 Shell')}
                    onChange={next =>
                      updateTerminal({
                        ...terminal,
                        defaultShell: next as TerminalShellId,
                      })
                    }
                    options={availableTerminalShells().map(id => ({
                      value: id,
                      label: t(terminalShellLabelKey(id)),
                    }))}
                  />
                </SettingItem>
                <SettingItem
                  title={t('终端 › 集成: 默认配置文件')}
                  description={t('新建终端时使用的默认配置。未指定时使用内置普通终端。')}
                  modified={terminal.defaultProfileId != null}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <SettingSelect
                    value={terminal.defaultProfileId ?? ''}
                    disabled={workspaceLocked}
                    className="setting-control-wide"
                    aria-label={t('终端 › 集成: 默认配置文件')}
                    onChange={next =>
                      updateTerminal({
                        ...terminal,
                        defaultProfileId: next ? next : null,
                      })
                    }
                    options={[
                      { value: '', label: t('未指定（内置默认）') },
                      ...terminal.profiles
                        .filter(profile => profile.id !== DEFAULT_TERMINAL_PROFILE.id)
                        .map(profile => ({
                          value: profile.id,
                          label: profile.name.trim() || t('未命名配置'),
                        })),
                    ]}
                  />
                </SettingItem>
                {!workspaceLocked && (
                  <div className="pl-3 border-l-2 border-transparent">
                    <p className="text-[12px] text-fg-muted mb-2">
                      {t('终端配置文件可在下方管理（名称、Shell 与启动命令）。')}
                    </p>
                    <TerminalProfilesInline settings={terminal} onChange={updateTerminal} />
                  </div>
                )}
              </Section>
            )}

            {match('功能', '快捷键', '打开方式', 'Open with', '检查更新', '自动检查更新') &&
              !workspaceLocked && (
              <Section
                id="features"
                title={t('功能')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                {match('检查更新', '自动检查更新', '更新') && (
                  <>
                    <SettingItem
                      title={t('启动时自动检查更新')}
                      description={t(
                        '正式构建启动后约 3 秒静默查询 Gitee / GitHub Release。关闭后仍可手动检查。',
                      )}
                      modified={checkOnStartup !== DEFAULT_UPDATE_SETTINGS.checkOnStartup}
                      locked={workspaceLocked}
                      lockHint={t('此设置仅在用户作用域中可用')}
                    >
                      <select
                        value={checkOnStartup ? 'on' : 'off'}
                        disabled={workspaceLocked}
                        onChange={e => {
                          const enabled = e.target.value === 'on'
                          setCheckOnStartup(enabled)
                          void saveCheckOnStartup(enabled).catch(error =>
                            pushToast(
                              'error',
                              t('保存更新设置失败: {error}', { error: String(error) }),
                            ),
                          )
                        }}
                        className="setting-control setting-select"
                      >
                        <option value="on">{t('开启')}</option>
                        <option value="off">{t('关闭')}</option>
                      </select>
                    </SettingItem>
                    <SettingItem
                      title={t('检查更新')}
                      description={t(
                        '查询远端最新便携版；发现新版本时提示打开下载页，不会自动安装。',
                      )}
                      modified={false}
                      locked={workspaceLocked}
                      lockHint={t('此设置仅在用户作用域中可用')}
                    >
                      <button
                        type="button"
                        disabled={updateCheckBusy || !isTauri() || workspaceLocked}
                        className="setting-control px-2.5 py-1 text-[12px] border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                        onClick={() => {
                          if (!isTauri()) {
                            pushToast('error', t('检查更新需要 Tauri 桌面环境'))
                            return
                          }
                          setUpdateCheckBusy(true)
                          void checkForAppUpdate({ ignoreSkip: true, prompt: false })
                            .then(async info => {
                              if (!info) {
                                pushToast('success', t('当前已是最新版本'))
                                return
                              }
                              await promptAppUpdate(info)
                            })
                            .catch(error =>
                              pushToast(
                                'error',
                                t('检查更新失败: {error}', { error: String(error) }),
                              ),
                            )
                            .finally(() => setUpdateCheckBusy(false))
                        }}
                      >
                        {updateCheckBusy ? t('正在检查…') : t('检查更新')}
                      </button>
                    </SettingItem>
                  </>
                )}
                {match('打开方式', 'Open with', 'Windows') && (
                  <SettingItem
                    title={t('Windows 打开方式')}
                    description={t(
                      '将 QingCode 添加到资源管理器「打开方式」菜单（常见代码/文本扩展名，不修改默认程序）。写入当前用户注册表，无需管理员权限。',
                    )}
                    modified={Boolean(openWith?.registered)}
                  >
                    <div className="flex flex-col items-end gap-2 max-w-md">
                      {!isTauri() || openWith?.supported === false ? (
                        <span className="text-[12px] text-fg-dim">
                          {t('仅 Windows 桌面版支持此功能。')}
                        </span>
                      ) : (
                        <>
                          <span className="text-[12px] text-fg-muted text-right">
                            {openWith?.registered ? t('已注册到「打开方式」') : t('尚未注册')}
                            {openWith?.extensions?.length
                              ? ` · ${t('已注册 {count} 种扩展名', { count: openWith.extensions.length })}`
                              : ''}
                          </span>
                          {openWith?.exe_path ? (
                            <Tooltip
                              label={openWith.exe_path}
                              side="bottom"
                              onlyWhenOverflow
                              wrapperClassName="block max-w-full min-w-0"
                            >
                              <span className="text-[11px] text-fg-dim font-mono truncate max-w-full block">
                                {t('当前程序：{path}', { path: openWith.exe_path })}
                              </span>
                            </Tooltip>
                          ) : null}
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              disabled={openWithBusy}
                              className="setting-control px-2.5 py-1 text-[12px] border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                              onClick={() => {
                                setOpenWithBusy(true)
                                void registerOpenWith()
                                  .then(status => {
                                    setOpenWith(status)
                                    pushToast(
                                      'success',
                                      t(
                                        '注册成功。可在资源管理器中右键文件 → 打开方式 → QingCode。',
                                      ),
                                    )
                                  })
                                  .catch(error =>
                                    pushToast(
                                      'error',
                                      t('注册失败: {error}', { error: String(error) }),
                                    ),
                                  )
                                  .finally(() => setOpenWithBusy(false))
                              }}
                            >
                              {t('注册「打开方式」')}
                            </button>
                            <button
                              type="button"
                              disabled={openWithBusy || !openWith?.registered}
                              className="setting-control px-2.5 py-1 text-[12px] border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                              onClick={() => {
                                setOpenWithBusy(true)
                                void unregisterOpenWith()
                                  .then(status => {
                                    setOpenWith(status)
                                    pushToast('success', t('已取消「打开方式」注册。'))
                                  })
                                  .catch(error =>
                                    pushToast(
                                      'error',
                                      t('取消注册失败: {error}', { error: String(error) }),
                                    ),
                                  )
                                  .finally(() => setOpenWithBusy(false))
                              }}
                            >
                              {t('取消注册')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </SettingItem>
                )}
                {match('快捷键', '键盘') && (
                  <>
                    <SettingItem
                      title={t('键盘快捷方式')}
                      description={t('自定义常用操作的按键组合。')}
                      modified={Object.keys(DEFAULT_SHORTCUTS).some(
                        key =>
                          shortcuts[key as ShortcutCommand] !==
                          DEFAULT_SHORTCUTS[key as ShortcutCommand],
                      )}
                    >
                      <span className="text-[12px] text-fg-dim">{t('见下方列表')}</span>
                    </SettingItem>
                    <div className="pl-3">
                      <ShortcutSettings />
                    </div>
                  </>
                )}
              </Section>
            )}

            {match('语言', '简体中文', 'English', '语言包', '自定义语言') && (
              <Section
                id="language"
                title={t('语言')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                <SettingItem
                  title={t('显示语言')}
                  description={t('选择界面显示语言。更改后立即生效。也可从用户语言包目录加载自定义 JSON。')}
                  modified={language !== 'zh-CN'}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={language}
                    disabled={workspaceLocked}
                    onChange={e => setLanguage(e.target.value)}
                    className="setting-control setting-control-wide setting-select"
                  >
                    {localeOptions.map(option => (
                      <option key={option.locale} value={option.locale}>
                        {option.builtin ? t(option.label) : option.label}
                      </option>
                    ))}
                  </select>
                </SettingItem>
                <SettingItem
                  title={t('自定义语言包')}
                  description={t(
                    '将 JSON 语言包放入应用数据目录的 locales 文件夹（可参考其中的 _example.json）。修改后点击刷新即可出现在上方列表。',
                  )}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={workspaceLocked || !isTauri()}
                      className="setting-control px-2.5 py-1 text-[12px]"
                      onClick={() => {
                        void (async () => {
                          try {
                            const result = await reloadUserLocales()
                            pushToast(
                              'info',
                              t('已刷新语言包（{count} 个用户包）', {
                                count: result.loaded,
                              }),
                            )
                          } catch (error) {
                            pushToast(
                              'error',
                              error instanceof Error ? error.message : String(error),
                            )
                          }
                        })()
                      }}
                    >
                      {t('刷新语言包')}
                    </button>
                    <button
                      type="button"
                      disabled={workspaceLocked || !isTauri()}
                      className="setting-control px-2.5 py-1 text-[12px]"
                      onClick={() => {
                        void (async () => {
                          try {
                            const dir = await safeInvoke<string>(
                              '读取语言包目录',
                              'user_locales_dir',
                            )
                            await revealItemInDir(dir)
                          } catch (error) {
                            pushToast(
                              'error',
                              error instanceof Error ? error.message : String(error),
                            )
                          }
                        })()
                      }}
                    >
                      {t('打开语言包目录')}
                    </button>
                  </div>
                </SettingItem>
              </Section>
            )}

            {match(
              '打开设置 JSON',
              'settings.json',
              '自定义设置',
              'files.exclude',
              'search.exclude',
              '不计划',
            ) && (
              <Section
                id="json"
                title={t('打开设置 JSON')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                <SettingItem
                  title={
                    scope === 'user'
                      ? t('打开用户设置 (JSON)')
                      : t('打开工作区设置 (JSON)')
                  }
                  description={
                    scope === 'user'
                      ? t(
                          '在编辑器中打开全局 default-settings.json（JSON5，可写注释）。可用 qingcode.projects 配置项目列表，启动时按 qingcode.projects.syncOnStartup 同步。',
                        )
                      : t(
                          '在编辑器中打开当前项目的 .qingcode/project-settings.json（JSON5，可写注释）。',
                        )
                  }
                >
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={openingJson || (scope === 'workspace' && !currentProject)}
                      onClick={() => void openSettingsJson(false)}
                      className="rounded bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent/90 disabled:opacity-50"
                    >
                      {t('在编辑器中打开')}
                    </button>
                    <button
                      type="button"
                      disabled={openingJson || (scope === 'workspace' && !currentProject)}
                      onClick={() => void openSettingsJson(true)}
                      className="rounded border border-border-strong px-3 py-1.5 text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
                    >
                      {t('写入默认模板并打开')}
                    </button>
                  </div>
                </SettingItem>
                <SettingItem
                  title={t('JSON 键生效说明')}
                  description={t(
                    'files.exclude / search.exclude / useIgnoreFiles / followSymlinks、explorer.excludeGitIgnore、files.encoding、editor.minimap.enabled、editor.formatOnSave / formatOnPaste、括号着色与参考线、terminal.integrated.scrollback / cursorBlinking 已生效。标有「不计划」的键（如 linkedEditing）会保存但不会改变行为。详见帮助文档。',
                  )}
                >
                  <span className="text-[12px] text-fg-dim">{t('见 JSON 注释 / 帮助文档')}</span>
                </SettingItem>
              </Section>
            )}
          </div>
        </div>
      </div>

      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

function Section({
  id,
  title,
  children,
  sectionRefs,
  onVisible,
}: {
  id: CategoryId
  title: string
  children: ReactNode
  sectionRefs: MutableRefObject<Partial<Record<CategoryId, HTMLElement | null>>>
  onVisible: (id: CategoryId) => void
}) {
  useEffect(() => {
    const el = sectionRefs.current[id]
    if (!el) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) onVisible(id)
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, onVisible, sectionRefs])

  return (
    <section
      ref={node => {
        sectionRefs.current[id] = node
      }}
      className="scroll-mt-4"
    >
      <h2 className="text-[18px] font-semibold text-fg mb-3 pb-2 border-b border-border">
        {title}
      </h2>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}

function SettingItem({
  title,
  description,
  modified,
  locked,
  lockHint,
  children,
}: {
  title: string
  description: string
  modified?: boolean
  locked?: boolean
  lockHint?: string
  children: ReactNode
}) {
  return (
    <div
      className={`relative pl-3 ${modified ? 'border-l-2 border-accent' : 'border-l-2 border-transparent'} ${
        locked ? 'opacity-70' : ''
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-[12rem] flex-1 basis-0">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted break-words">{description}</p>
          {locked && lockHint && (
            <p className="mt-1 text-[11px] text-warn break-words">{lockHint}</p>
          )}
        </div>
        <div className="w-full sm:w-auto sm:max-w-[min(100%,320px)] sm:flex-shrink-0 pt-0.5">{children}</div>
      </div>
    </div>
  )
}

function TerminalProfilesInline({
  settings,
  onChange,
}: {
  settings: TerminalProfileSettings
  onChange: (next: TerminalProfileSettings) => void
}) {
  const { t } = useI18n()
  const customProfiles = settings.profiles.filter(p => p.id !== DEFAULT_TERMINAL_PROFILE.id)
  const shellOptions = availableTerminalShells().map(id => ({
    value: id,
    label: t(terminalShellLabelKey(id)),
  }))

  return (
    <div className="flex flex-col gap-2">
      {customProfiles.map(profile => (
        <div key={profile.id} className="flex flex-col gap-1.5 rounded border border-border p-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              value={profile.name}
              onChange={e =>
                onChange({
                  ...settings,
                  profiles: settings.profiles.map(item =>
                    item.id === profile.id ? { ...item, name: e.target.value } : item,
                  ),
                })
              }
              placeholder={t('名称')}
              className="setting-control setting-control-wide !w-full"
            />
            <button
              type="button"
              onClick={() => {
                const profiles = settings.profiles.filter(item => item.id !== profile.id)
                onChange({
                  ...settings,
                  profiles,
                  defaultProfileId:
                    settings.defaultProfileId === profile.id ? null : settings.defaultProfileId,
                })
              }}
              className="h-[26px] px-2 rounded-sm text-[12px] text-danger hover:bg-bg-hover"
            >
              {t('删除')}
            </button>
          </div>
          <SettingSelect
            value={profile.shell}
            className="setting-control setting-control-wide !w-full !h-[26px]"
            aria-label={t('Shell')}
            onChange={next =>
              onChange({
                ...settings,
                profiles: settings.profiles.map(item =>
                  item.id === profile.id
                    ? { ...item, shell: next as TerminalShellId }
                    : item,
                ),
              })
            }
            options={shellOptions}
          />
          <input
            value={profile.command}
            onChange={e =>
              onChange({
                ...settings,
                profiles: settings.profiles.map(item =>
                  item.id === profile.id ? { ...item, command: e.target.value } : item,
                ),
              })
            }
            placeholder={t('启动命令')}
            className="setting-control setting-control-wide !w-full font-mono"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            ...settings,
            profiles: [
              ...settings.profiles,
              {
                id: crypto.randomUUID(),
                name: t('新终端配置'),
                command: '',
                shell: settings.defaultShell,
              },
            ],
          })
        }
        className="self-start rounded border border-border-strong px-2 py-1 text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        {t('添加终端配置')}
      </button>
    </div>
  )
}
