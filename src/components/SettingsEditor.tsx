import { SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import { preferredScrollBehavior } from '../lib/motionPreferences'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  CircleHelp,
  Search,
  Settings2,
  X,
  MoreHorizontal,
} from 'lucide-react'
import { useI18n } from '../lib/i18n'
import GitPushSyncSection from '../features/gitPushSync/GitPushSyncSection'
import {
  FONT_SETTINGS_EVENT,
  loadFontSettings,
  saveFontSettings,
  type FontSettings,
} from '../lib/fontSettings'
import {
  loadTheme,
  saveTheme,
  type AppTheme,
} from '../lib/themeSettings'
import {
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  TERMINAL_PROFILES_KEY,
  type TerminalProfileSettings,
} from '@/lib/terminal/terminalProfiles'
import { useShortcutStore } from '../store/shortcutStore'
import HelpDialog from './HelpDialog'
import SegmentedControl from './SegmentedControl'
import Tooltip from './Tooltip'
import ContextMenu from './ContextMenu'
import { SETTINGS_CATEGORIES, matchesSettingsCategory, matchesSettingsTerms } from '../lib/settingsSearch'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import {
  loadEffectiveSshServerEnabled,
  pushSshServerSettingsToNative,
} from '../lib/sshServerSettings'
import MobileConnectionSettings from './settings/MobileConnectionSettings'
import AppearanceSettingsSection from './settings/AppearanceSettingsSection'
import EditorSettingsSection from './settings/EditorSettingsSection'
import TerminalSettingsSection from './settings/TerminalSettingsSection'
import ProjectSessionSettingsSection from './settings/ProjectSessionSettingsSection'
import RemoteSettingsSection from './settings/RemoteSettingsSection'
import ToolsSettingsSection from './settings/ToolsSettingsSection'
import ShortcutsSettingsSection from './settings/ShortcutsSettingsSection'
import AboutSettingsSection from './settings/AboutSettingsSection'
import {
  useAboutSettings,
  useEditorFileSettings,
  useProjectSessionSettings,
  useTerminalIntegrationSettings,
  useToolsIntegrationSettings,
} from './settings/useSettingsSectionState'
import { useSettingsManagement } from './settings/useSettingsManagement'
import type { FontSettingUpdater, SettingsScope } from './settings/types'
import {
  SettingsSection as Section,
  type SettingsCategoryId as CategoryId,
} from './SettingsLayout'

/** Survives Strict Mode remounts so a stale deep-link is not reapplied. */
let appliedSettingsFocusSignal = 0

export default function SettingsEditor() {
  const { t, language } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const pushToast = useProjectStore(s => s.pushToast)
  const settingsFocusQuery = useUIStore(s => s.settingsFocusQuery)
  const settingsFocusSignal = useUIStore(s => s.settingsFocusSignal)
  const shortcuts = useShortcutStore(s => s.shortcuts)

  const [scope, setScope] = useState<SettingsScope>('user')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryId>('appearance')
  const [helpOpen, setHelpOpen] = useState(false)
  // 主题 / 字体 / 终端配置由多个分区共用，并随「导入配置」整体刷新，因此留在外壳。
  const [theme, setThemeState] = useState<AppTheme>(loadTheme)
  const [fonts, setFonts] = useState<FontSettings>(loadFontSettings)
  const [terminal, setTerminal] = useState<TerminalProfileSettings>(loadTerminalProfileSettings)
  const [managementMenu, setManagementMenu] = useState<{ x: number; y: number } | null>(null)
  const [scopeDetails, setScopeDetails] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const terminalProfilesRef = useRef<HTMLDivElement>(null)
  const categoryNavRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Partial<Record<CategoryId, HTMLElement | null>>>({})
  const onSectionRef = useCallback((id: CategoryId, node: HTMLElement | null) => {
    sectionRefs.current[id] = node
  }, [])

  // 分区状态在外壳持有：分区因切换分类 / 搜索卸载时不丢状态、不重复读盘。
  const toolsSettings = useToolsIntegrationSettings()
  const projectSessionSettings = useProjectSessionSettings(settingsRevision)
  const aboutSettings = useAboutSettings(settingsRevision)
  const editorFileSettings = useEditorFileSettings(scope, currentProject, settingsRevision)
  const terminalSettings = useTerminalIntegrationSettings(scope, currentProject, settingsRevision)
  const {
    openingJson,
    transferBusy,
    openSettingsJson,
    transferSettings,
    restoreDefaults,
  } = useSettingsManagement(scope, currentProject)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    const refresh = () => {
      setThemeState(loadTheme())
      setFonts(loadFontSettings())
      setTerminal(loadTerminalProfileSettings())
      setSettingsRevision(value => value + 1)
      // 导入会重写设置文件：刷新模块缓存后必须把生效值重新推给 native，
      // 否则常驻后端仍按旧配置运行。失败要让用户看见，不能只写 console。
      void (async () => {
        try {
          await loadEffectiveSshServerEnabled(currentProject)
          await pushSshServerSettingsToNative()
        } catch (error) {
          pushToast('error', t('推送 SSH 服务设置失败: {error}', { error: String(error) }))
        }
      })()
    }
    window.addEventListener('qingcode:settings-imported', refresh)
    return () => window.removeEventListener('qingcode:settings-imported', refresh)
  }, [currentProject, pushToast, t])

  useEffect(() => {
    const refresh = () => setTerminal(loadTerminalProfileSettings())
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === TERMINAL_PROFILES_KEY) refresh()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SHELL_PREWARM_CHANGED_EVENT, refresh)
    }
  }, [])

  useEffect(() => {
    const onFonts = () => setFonts(loadFontSettings())
    window.addEventListener(FONT_SETTINGS_EVENT, onFonts)
    return () => window.removeEventListener(FONT_SETTINGS_EVENT, onFonts)
  }, [])

  useEffect(() => {
    if (settingsFocusSignal === 0 || settingsFocusSignal <= appliedSettingsFocusSignal) return
    appliedSettingsFocusSignal = settingsFocusSignal
    const targetCategory = settingsFocusQuery === '终端配置' ? 'terminal' : 'editor'
    queueMicrotask(() => {
      setScope('user')
      if (settingsFocusQuery) {
        setQuery(settingsFocusQuery)
        setCategory(targetCategory)
      }
    })
    requestAnimationFrame(() => {
      const target = settingsFocusQuery === '终端配置'
        ? terminalProfilesRef.current
        : sectionRefs.current[targetCategory]
      target?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' })
      searchRef.current?.focus()
    })
  }, [settingsFocusSignal, settingsFocusQuery])

  useEffect(() => {
    if (scope === 'workspace' && !currentProject) queueMicrotask(() => setScope('user'))
  }, [scope, currentProject])

  const workspaceLocked = scope === 'workspace'
  const q = query.trim().toLowerCase()
  const isWindows = /Windows/i.test(navigator.userAgent)

  const match = useCallback(
    (...texts: string[]) => matchesSettingsTerms(q, texts, workspaceLocked, t, isWindows),
    [q, workspaceLocked, t, isWindows],
  )
  const availableCategories = SETTINGS_CATEGORIES.filter(cat =>
    matchesSettingsCategory(cat.id, '', workspaceLocked, t, isWindows),
  )
  const activeCategory = availableCategories.some(cat => cat.id === category)
    ? category : availableCategories[0]?.id
  const categoryMatches = (id: CategoryId) =>
    matchesSettingsCategory(id, q, workspaceLocked, t, isWindows) ||
    (id === 'shortcuts' && !workspaceLocked && Boolean(q) && Object.values(shortcuts).some(value => value.toLowerCase().includes(q)))
  const sectionVisible = (id: CategoryId) =>
    categoryMatches(id) && (Boolean(q) || activeCategory === id)

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [activeCategory, q, scope])

  useEffect(() => {
    categoryNavRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeCategory, q, language, fonts.interfaceFontSize])

  const updateTheme = (value: AppTheme) => {
    setThemeState(value)
    saveTheme(value)
  }

  const updateFonts: FontSettingUpdater = (key, value) => {
    const next = { ...fonts, [key]: value }
    setFonts(next)
    saveFontSettings(next)
  }

  const updateTerminal = (next: TerminalProfileSettings) => {
    setTerminal(next)
    saveTerminalProfileSettings(next)
  }

  const selectCategory = (id: CategoryId) => {
    setQuery('')
    setCategory(id)
  }

  const visibleCategories = SETTINGS_CATEGORIES.filter(cat => categoryMatches(cat.id))

  return (
    <div className="settings-shell ui-font-scaled h-full flex flex-col bg-bg text-fg min-w-0">
      {/* Tab strip like VS Code */}
      <div className="flex-shrink-0 h-[var(--tab-height)] flex items-stretch border-b border-border bg-bg-sidebar">
        <div className="relative flex items-center gap-2 px-3 border-r border-border bg-bg min-w-0">
          <span className="absolute inset-x-0 bottom-0 h-[2px] bg-brand" aria-hidden />
          <Settings2 size={14} className="text-brand flex-shrink-0" />
          <span className="text-ui truncate">{t('设置')}</span>
        </div>
      </div>

      {/* Header: scope + search + actions */}
      <div className="flex-shrink-0 border-b border-border bg-bg pt-3 pb-3">
        <div className="flex flex-wrap items-center gap-2 mb-3 px-4">
          <SegmentedControl
            ariaLabel={t('设置范围')}
            options={[
              { value: 'user', label: t('用户'), disabled: transferBusy },
              { value: 'workspace', label: t('当前项目'), disabled: transferBusy || !currentProject },
            ]}
            value={scope}
            onChange={value => {
              if (value === 'workspace' && !currentProject) return
              setScope(value)
            }}
          />
          <div className="min-w-0 flex-1" />
          <Tooltip label={t('管理设置')} side="bottom">
            <button type="button" aria-label={t('管理设置')} aria-haspopup="menu" aria-expanded={Boolean(managementMenu)}
              disabled={transferBusy || openingJson}
              onClick={event => { event.currentTarget.focus(); const rect = event.currentTarget.getBoundingClientRect(); setManagementMenu({ x: rect.right - 200, y: rect.bottom + 4 }) }}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg">
              <MoreHorizontal size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t('帮助文档')} side="bottom">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="inline-flex ui-chip h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
              aria-label={t('帮助文档')}
            >
              <CircleHelp size={15} />
            </button>
          </Tooltip>
        </div>

        {/* Search aligns with the content column (TOC is 200px; content uses px-6 + max-w-[800px]). */}
        <div className="flex min-w-0">
          <div className="settings-search-spacer w-[200px] flex-shrink-0" aria-hidden />
          <div className="settings-content-padding flex-1 min-w-0 px-6">
            <div className="relative max-w-[800px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim" />
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('搜索设置')}
                className="setting-input w-full h-8 pl-8 pr-8 text-ui"
              />
              {query && (
                <button
                  type="button"
                  aria-label={t('清除搜索')}
                  onClick={() => { setQuery(''); searchRef.current?.focus() }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-fg-muted">
              <span className="min-w-0 break-words">{scope === 'user' ? t('作用于所有项目') : t('当前项目：{name}', { name: currentProject?.name ?? '' })}</span>
              <button type="button" aria-expanded={scopeDetails} onClick={() => setScopeDetails(value => !value)} className="rounded px-1 text-accent hover:bg-bg-hover">{t(scopeDetails ? '收起说明' : '范围说明')}</button>
            </div>
            {scopeDetails && <p className="mt-1 text-ui-sm text-fg-muted break-words">{scope === 'user'
              ? t('导出用户设置、界面偏好和本地项目列表；导入按键合并，保留已有项目，不导入信任授权。')
              : t('当前项目设置覆盖用户设置；未设置的选项继续继承。多项目工作区仅用于组织项目和保存会话。')}</p>}

          </div>
        </div>
      </div>

      <div className="settings-body flex flex-1 min-h-0">
        {/* Categories */}
        <nav ref={categoryNavRef} aria-label={t('设置分类')} className="settings-nav w-[200px] flex-shrink-0 border-r border-border overflow-auto py-2 bg-bg">
          {visibleCategories.map(cat => (
            <button
              key={cat.id}
              type="button"
              onClick={() => selectCategory(cat.id)}
              aria-current={!q && activeCategory === cat.id ? 'page' : undefined}
              className={`block w-full px-4 py-1.5 text-left text-ui break-words whitespace-normal transition-colors ${
                !q && activeCategory === cat.id
                  ? 'bg-bg-active text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
            >
              {t(cat.label)}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div ref={contentRef} className="settings-content settings-content-padding flex-1 min-h-0 min-w-0 overflow-auto px-6 py-4">
          <div className="max-w-[800px] flex flex-col gap-6">
            {visibleCategories.length === 0 && <div role="status" className="py-8 text-ui text-fg-muted">
              <p>{t('没有匹配的设置：{query}', { query })}</p>
              <button type="button" className="mt-3 rounded px-2 py-1 text-accent hover:bg-bg-hover" onClick={() => { setQuery(''); searchRef.current?.focus() }}>{t('清除搜索')}</button>
            </div>}

            {sectionVisible('appearance') && (
              <Section id="appearance" title={t('外观与语言')} onSectionRef={onSectionRef}>
                <AppearanceSettingsSection
                  match={match}
                  workspaceLocked={workspaceLocked}
                  theme={theme}
                  onThemeChange={updateTheme}
                  fonts={fonts}
                  onFontChange={updateFonts}
                />
              </Section>
            )}

            {sectionVisible('editor') && (
              <Section id="editor" title={t('编辑器与文件')} onSectionRef={onSectionRef}>
                <EditorSettingsSection
                  match={match}
                  workspaceLocked={workspaceLocked}
                  projectMissing={scope === 'workspace' && !currentProject}
                  fonts={fonts}
                  onFontChange={updateFonts}
                  settings={editorFileSettings}
                />
              </Section>
            )}

            {sectionVisible('terminal') && (
              <Section id="terminal" title={t('终端')} onSectionRef={onSectionRef}>
                <TerminalSettingsSection
                  match={match}
                  workspaceLocked={workspaceLocked}
                  currentProject={currentProject}
                  fonts={fonts}
                  onFontChange={updateFonts}
                  terminal={terminal}
                  onTerminalChange={updateTerminal}
                  profilesRef={terminalProfilesRef}
                  settings={terminalSettings}
                />
              </Section>
            )}

            {sectionVisible('projects') && (
              <Section id="projects" title={t('项目与会话')} onSectionRef={onSectionRef}>
                <ProjectSessionSettingsSection
                  match={match}
                  workspaceLocked={workspaceLocked}
                  settings={projectSessionSettings}
                />
              </Section>
            )}

            {sectionVisible('remote') && (
              <Section id="remote" title={t('远程连接')} onSectionRef={onSectionRef}>
                <RemoteSettingsSection
                  match={match}
                  workspaceLocked={workspaceLocked}
                  scope={scope}
                  project={currentProject}
                  settingsRevision={settingsRevision}
                />
              </Section>
            )}

            {sectionVisible('gitPushSync') && (
              <Section id="gitPushSync" title={t('Git 多端同步')} onSectionRef={onSectionRef}>
                <GitPushSyncSection />
              </Section>
            )}

            {sectionVisible('mobile') && (
              <Section id="mobile" title={t('移动连接')} onSectionRef={onSectionRef}>
                <MobileConnectionSettings />
              </Section>
            )}

            {sectionVisible('tools') && (
              <Section id="tools" title={t('工具与集成')} onSectionRef={onSectionRef}>
                <ToolsSettingsSection
                  match={match}
                  workspaceLocked={workspaceLocked}
                  isWindows={isWindows}
                  settings={toolsSettings}
                />
              </Section>
            )}

            {sectionVisible('shortcuts') && (
              <Section id="shortcuts" title={t('快捷键')} onSectionRef={onSectionRef}>
                <ShortcutsSettingsSection query={q} />
              </Section>
            )}

            {sectionVisible('about') && (
              <Section id="about" title={t('更新与关于')} onSectionRef={onSectionRef}>
                <AboutSettingsSection
                  match={match}
                  workspaceLocked={workspaceLocked}
                  settings={aboutSettings}
                />
              </Section>
            )}
          </div>
        </div>
      </div>

      {managementMenu && <ContextMenu x={managementMenu.x} y={managementMenu.y} onClose={() => setManagementMenu(null)} items={[
        { label: t('打开设置 JSON'), disabled: openingJson || transferBusy, action: () => openSettingsJson(false) },
        { label: t('写入默认模板并打开'), disabled: openingJson || transferBusy, action: () => openSettingsJson(true) },
        { label: t('导入配置 JSON'), separatorBefore: true, action: () => transferSettings('import') },
        { label: t('导出配置 JSON'), action: () => transferSettings('export') },
        { label: t('恢复默认设置'), separatorBefore: true, action: restoreDefaults },
      ]} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  )
}
