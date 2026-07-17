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
  FileJson,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { useI18n, localeOptions, type AppLanguage } from '../lib/i18n'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_OPTIONS,
  INTERFACE_FONT_OPTIONS,
  MONO_FONT_OPTIONS,
  loadFontSettings,
  saveFontSettings,
  withCurrentFontOption,
  type FontSettings,
} from '../lib/fontSettings'
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
import { useShortcutStore } from '../store/shortcutStore'
import { DEFAULT_SHORTCUTS, type ShortcutCommand } from '../lib/shortcuts'
import ShortcutSettings from './ShortcutSettings'
import HelpDialog from './HelpDialog'
import Tooltip from './Tooltip'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import {
  ensureSettingsFile,
  resolveGlobalSettingsPath,
  resolveProjectSettingsPath,
} from '../lib/projectSettings'
import { isTauri } from '../lib/tauri'

type SettingsScope = 'user' | 'workspace'
type CategoryId =
  | 'common'
  | 'appearance'
  | 'editor'
  | 'terminal'
  | 'features'
  | 'language'
  | 'json'

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
  const { t, language, setLanguage } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const pushToast = useProjectStore(s => s.pushToast)
  const openFile = useEditorStore(s => s.openFile)
  const setView = useUIStore(s => s.setView)
  const shortcuts = useShortcutStore(s => s.shortcuts)

  const [scope, setScope] = useState<SettingsScope>('user')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryId>('common')
  const [helpOpen, setHelpOpen] = useState(false)
  const [theme, setThemeState] = useState<AppTheme>(loadTheme)
  const [fonts, setFonts] = useState<FontSettings>(loadFontSettings)
  const [terminal, setTerminal] = useState<TerminalProfileSettings>(loadTerminalProfileSettings)
  const [openingJson, setOpeningJson] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const sectionRefs = useRef<Partial<Record<CategoryId, HTMLElement | null>>>({})

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    if (scope === 'workspace' && !currentProject) setScope('user')
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
      if (cat.id === 'json') return match('打开设置 JSON', 'settings.json', '自定义设置')
      if (cat.id === 'common') {
        return match('颜色主题', '界面字号', '编辑器字号', '常用设置')
      }
      if (cat.id === 'appearance') return match('颜色主题', '外观', '深色', '浅色')
      if (cat.id === 'editor') return match('界面字体', '代码字体', '编辑器字号', '文本编辑器')
      if (cat.id === 'terminal') return match('终端', '默认启动配置', '终端字号')
      if (cat.id === 'features') return match('快捷键', '功能', '打开搜索', '切换终端')
      if (cat.id === 'language') return match('语言', '简体中文', 'English')
      return true
    })
  }, [q, language, shortcuts])

  return (
    <div className="ui-font-scaled h-full flex flex-col bg-bg text-fg min-w-0">
      {/* Tab strip like VS Code */}
      <div className="flex-shrink-0 h-[35px] flex items-stretch border-b border-border bg-bg-sidebar">
        <div className="flex items-center gap-2 px-3 border-r border-border bg-bg min-w-0">
          <Settings2 size={14} className="text-fg-muted flex-shrink-0" />
          <span className="text-[13px] truncate">{t('设置')}</span>
        </div>
      </div>

      {/* Header: scope + search + actions */}
      <div className="flex-shrink-0 border-b border-border bg-bg px-4 pt-3 pb-3">
        <div className="flex items-center gap-2 mb-3">
          <ScopeButton
            active={scope === 'user'}
            onClick={() => setScope('user')}
          >
            {t('用户')}
          </ScopeButton>
          <ScopeButton
            active={scope === 'workspace'}
            disabled={!currentProject}
            onClick={() => currentProject && setScope('workspace')}
          >
            {t('工作区')}
          </ScopeButton>
          <div className="flex-1" />
          <Tooltip label={t('在编辑器中打开设置 JSON')} side="bottom">
            <button
              type="button"
              disabled={openingJson}
              onClick={() => void openSettingsJson(false)}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
            >
              <FileJson size={15} />
            </button>
          </Tooltip>
          <Tooltip label={t('帮助文档')} side="bottom">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <CircleHelp size={15} />
            </button>
          </Tooltip>
        </div>

        <div className="relative max-w-[720px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('搜索设置')}
            className="w-full h-8 pl-8 pr-8 rounded-sm border border-border-strong bg-bg-deep text-[13px] text-fg outline-none focus:border-accent"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {scope === 'workspace' && (
          <p className="mt-2 text-[12px] text-fg-muted">
            {t('工作区设置作用于当前项目「{name}」。多数界面设置仅用户作用域可用；工作区主要用于 project-settings.json。', {
              name: currentProject?.name ?? '',
            })}
          </p>
        )}
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
            {match('常用设置', '颜色主题', '界面字号', '编辑器字号') && (
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
                    <select
                      value={theme}
                      disabled={workspaceLocked}
                      onChange={e => updateTheme(e.target.value as AppTheme)}
                      className="setting-control"
                    >
                      {THEMES.map(option => (
                        <option key={option.value} value={option.value}>
                          {t(option.label)}
                        </option>
                      ))}
                    </select>
                  </SettingItem>
                )}
                {match('界面字号', '字体') && (
                  <SettingItem
                    title={t('界面字号')}
                    description={t('控制菜单、侧栏、标签和状态栏的字号（像素）。')}
                    modified={fonts.interfaceFontSize !== DEFAULT_FONT_SETTINGS.interfaceFontSize}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <select
                      value={fonts.interfaceFontSize}
                      disabled={workspaceLocked}
                      onChange={e => updateFonts('interfaceFontSize', Number(e.target.value))}
                      className="setting-control"
                    >
                      {FONT_SIZE_OPTIONS.map(size => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </SettingItem>
                )}
                {match('编辑器字号', '代码字号') && (
                  <SettingItem
                    title={t('编辑器: 字号')}
                    description={t('控制编辑器中的字号（像素）。')}
                    modified={fonts.editorFontSize !== DEFAULT_FONT_SETTINGS.editorFontSize}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <select
                      value={fonts.editorFontSize}
                      disabled={workspaceLocked}
                      onChange={e => updateFonts('editorFontSize', Number(e.target.value))}
                      className="setting-control"
                    >
                      {FONT_SIZE_OPTIONS.map(size => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
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
                  <div className="flex flex-wrap gap-2">
                    {THEMES.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        disabled={workspaceLocked}
                        onClick={() => updateTheme(option.value)}
                        className={`min-w-[88px] rounded border px-2 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${
                          theme === option.value
                            ? 'border-accent bg-accent/15 text-fg'
                            : 'border-border-strong text-fg-muted hover:border-accent/60 hover:text-fg'
                        }`}
                      >
                        {t(option.label)}
                      </button>
                    ))}
                  </div>
                </SettingItem>
              </Section>
            )}

            {match('文本编辑器', '界面字体', '代码字体', '编辑器字号', '终端字号') && (
              <Section
                id="editor"
                title={t('文本编辑器')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                <SettingItem
                  title={t('界面字体')}
                  description={t('用于菜单、侧栏、标签和状态栏的字体族。')}
                  modified={fonts.interfaceFont !== DEFAULT_FONT_SETTINGS.interfaceFont}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={fonts.interfaceFont}
                    disabled={workspaceLocked}
                    onChange={e => updateFonts('interfaceFont', e.target.value)}
                    className="setting-control setting-control-wide"
                    style={{ fontFamily: 'var(--font-sans)' }}
                  >
                    {withCurrentFontOption(INTERFACE_FONT_OPTIONS, fonts.interfaceFont).map(option => (
                      <option key={option.value} value={option.value}>{t(option.label)}</option>
                    ))}
                  </select>
                </SettingItem>
                <SettingItem
                  title={t('编辑器: 字体族')}
                  description={t('控制编辑器字体族。终端默认共用同一等宽字体。')}
                  modified={fonts.monoFont !== DEFAULT_FONT_SETTINGS.monoFont}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={fonts.monoFont}
                    disabled={workspaceLocked}
                    onChange={e => updateFonts('monoFont', e.target.value)}
                    className="setting-control setting-control-wide font-mono"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  >
                    {withCurrentFontOption(MONO_FONT_OPTIONS, fonts.monoFont).map(option => (
                      <option key={option.value} value={option.value}>{t(option.label)}</option>
                    ))}
                  </select>
                </SettingItem>
                <SettingItem
                  title={t('编辑器: 字号')}
                  description={t('控制编辑器中的字号（像素）。')}
                  modified={fonts.editorFontSize !== DEFAULT_FONT_SETTINGS.editorFontSize}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={fonts.editorFontSize}
                    disabled={workspaceLocked}
                    onChange={e => updateFonts('editorFontSize', Number(e.target.value))}
                    className="setting-control"
                  >
                    {FONT_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </SettingItem>
              </Section>
            )}

            {match('终端', '默认启动配置', '终端字号') && (
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
                    className="setting-control"
                  >
                    {FONT_SIZE_OPTIONS.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </SettingItem>
                <SettingItem
                  title={t('终端 › 集成: 默认配置文件')}
                  description={t('新建终端时使用的默认配置。未指定时使用内置普通 PowerShell 终端。')}
                  modified={terminal.defaultProfileId != null}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={terminal.defaultProfileId ?? ''}
                    disabled={workspaceLocked}
                    onChange={e =>
                      updateTerminal({
                        ...terminal,
                        defaultProfileId: e.target.value ? e.target.value : null,
                      })
                    }
                    className="setting-control setting-control-wide"
                  >
                    <option value="">{t('未指定（内置默认）')}</option>
                    {terminal.profiles
                      .filter(profile => profile.id !== DEFAULT_TERMINAL_PROFILE.id)
                      .map(profile => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name.trim() || t('未命名配置')}
                        </option>
                      ))}
                  </select>
                </SettingItem>
                {!workspaceLocked && (
                  <div className="pl-3 border-l-2 border-transparent">
                    <p className="text-[12px] text-fg-muted mb-2">
                      {t('终端配置文件可在下方管理（名称与启动命令）。')}
                    </p>
                    <TerminalProfilesInline settings={terminal} onChange={updateTerminal} />
                  </div>
                )}
              </Section>
            )}

            {match('功能', '快捷键') && !workspaceLocked && (
              <Section
                id="features"
                title={t('功能')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                <SettingItem
                  title={t('键盘快捷方式')}
                  description={t('自定义常用操作的按键组合。')}
                  modified={Object.keys(DEFAULT_SHORTCUTS).some(
                    key => shortcuts[key as ShortcutCommand] !== DEFAULT_SHORTCUTS[key as ShortcutCommand],
                  )}
                >
                  <span className="text-[12px] text-fg-dim">{t('见下方列表')}</span>
                </SettingItem>
                <div className="pl-3">
                  <ShortcutSettings />
                </div>
              </Section>
            )}

            {match('语言', '简体中文', 'English') && (
              <Section
                id="language"
                title={t('语言')}
                sectionRefs={sectionRefs}
                onVisible={setCategory}
              >
                <SettingItem
                  title={t('显示语言')}
                  description={t('选择界面显示语言。更改后立即生效。')}
                  modified={language !== 'zh-CN'}
                  locked={workspaceLocked}
                  lockHint={t('此设置仅在用户作用域中可用')}
                >
                  <select
                    value={language}
                    disabled={workspaceLocked}
                    onChange={e => setLanguage(e.target.value as AppLanguage)}
                    className="setting-control setting-control-wide"
                  >
                    {localeOptions.map(option => (
                      <option key={option.locale} value={option.locale}>
                        {t(option.label)}
                      </option>
                    ))}
                  </select>
                </SettingItem>
              </Section>
            )}

            {match('打开设置 JSON', 'settings.json', '自定义设置') && (
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
              </Section>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .setting-control {
          min-width: 120px;
          max-width: 100%;
          height: 26px;
          border-radius: 2px;
          border: 1px solid var(--color-border-strong, #3c3c3c);
          background: var(--color-bg-deep, #181818);
          color: inherit;
          padding: 0 8px;
          font-size: 13px;
          outline: none;
        }
        .setting-control:focus {
          border-color: var(--color-accent, #4d9eff);
        }
        .setting-control:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .setting-control-wide {
          min-width: 220px;
          width: min(100%, 320px);
        }
      `}</style>

      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

function ScopeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`h-7 px-3 rounded-sm text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'bg-bg-active text-fg'
          : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
      }`}
    >
      {children}
    </button>
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
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{description}</p>
          {locked && lockHint && (
            <p className="mt-1 text-[11px] text-warn">{lockHint}</p>
          )}
        </div>
        <div className="flex-shrink-0 pt-0.5">{children}</div>
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

  return (
    <div className="flex flex-col gap-2">
      {customProfiles.map(profile => (
        <div key={profile.id} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
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
          <button
            type="button"
            onClick={() => {
              const profiles = settings.profiles.filter(item => item.id !== profile.id)
              onChange({
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
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            ...settings,
            profiles: [
              ...settings.profiles,
              { id: crypto.randomUUID(), name: t('新终端配置'), command: '' },
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
