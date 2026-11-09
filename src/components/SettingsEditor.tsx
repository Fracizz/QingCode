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
import { revealItemInDir, openUrl } from '@tauri-apps/plugin-opener'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SETTINGS_EVENT,
  FONT_SIZE_OPTIONS,
  INTERFACE_FONT_OPTIONS,
  MONO_FONT_OPTIONS,
  TERMINAL_FONT_OPTIONS,
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
  loadTerminalProfileSettings,
  saveTerminalProfileSettings,
  type TerminalProfileSettings,
} from '@/lib/terminal/terminalProfiles'
import {
  availableTerminalShells,
  defaultTerminalShell,
  terminalShellLabelKey,
  type TerminalShellId,
} from '@/lib/terminal/terminalShell'
import { useShortcutStore } from '../store/shortcutStore'
import { DEFAULT_SHORTCUTS, type ShortcutCommand } from '../lib/shortcuts'
import ShortcutSettings from './ShortcutSettings'
import HelpDialog from './HelpDialog'
import SegmentedControl from './SegmentedControl'
import Tooltip from './Tooltip'
import ContextMenu from './ContextMenu'
import { SETTINGS_CATEGORIES, matchesSettingsCategory, matchesSettingsTerms } from '../lib/settingsSearch'
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
import { hasBackend } from '../lib/runtimeCapabilities'
import {
  getOpenWithStatus,
  registerOpenWith,
  unregisterOpenWith,
  type OpenWithStatus,
} from '../lib/openWithSettings'
import { buildQingcodeCliSkillMarkdown } from '../lib/qingcodeCliSkill'
import { copyToClipboard } from '../utils/fileReferences'
import {
  getMinimapEnabled,
  loadScopedMinimapEnabled,
  saveScopedMinimapEnabled,
} from '../lib/minimapSettings'
import {
  getTerminalSshUploadOnPaste,
  loadScopedTerminalSshUploadOnPaste,
  saveScopedTerminalSshUploadOnPaste,
} from '../lib/terminal/terminalSshUploadSettings'
import {
  getTerminalShiftEnterNewline,
  loadScopedTerminalShiftEnterNewline,
  saveScopedTerminalShiftEnterNewline,
} from '../lib/terminal/terminalShiftEnterSettings'
import {
  getTerminalPersistLocalSessions,
  loadScopedTerminalPersistLocalSessions,
  saveScopedTerminalPersistLocalSessions,
} from '../lib/terminal/terminalPersistLocalSettings'
import {
  getTerminalLargePasteAsFile,
  loadScopedTerminalLargePasteAsFile,
  saveScopedTerminalLargePasteAsFile,
} from '../lib/terminal/terminalLargePasteSettings'
import {
  getTerminalActivityIndicator,
  loadScopedTerminalActivityIndicator,
  saveScopedTerminalActivityIndicator,
} from '../lib/terminal/terminalActivitySettings'
import { confirmClearSshTerminalPasteUploads } from '../lib/sshTerminalPaste'
import {
  loadEffectiveSshServerEnabled,
  pushSshServerSettingsToNative,
  SSH_SERVER_AUTO_DOWNLOAD_KEY,
  SSH_SERVER_ENABLED_KEY,
  SSH_SERVER_OFFLINE_DIR_KEY,
} from '../lib/sshServerSettings'
import { isSshProject } from '../lib/sshWorkspace'
import SshServerSettingsSection from './settings/SshServerSettingsSection'
import MobileConnectionSettings from './settings/MobileConnectionSettings'
import {
  loadScopedEditorGuidesEnabled,
  saveScopedEditorGuidesEnabled,
} from '../lib/editorSettings'
import {
  DEFAULT_UPDATE_SETTINGS,
  loadUpdateSettings,
  saveCheckOnStartup,
} from '../lib/updateSettings'
import {
  DEFAULT_SESSION_PERSIST,
  loadSessionPersistEnabled,
  saveSessionPersistEnabled,
} from '../lib/sessionPersistSettings'
import {
  DEFAULT_EDITOR_STATE_CACHE_SIZE,
  MAX_EDITOR_STATE_CACHE_SIZE,
  MIN_EDITOR_STATE_CACHE_SIZE,
  loadEditorStateCacheSize,
  saveEditorStateCacheSize,
  type EditorStateCacheSizeSetting,
} from '../lib/editorStateCacheSettings'
import {
  DEFAULT_PROJECT_INDICATORS_ENABLED,
  loadProjectIndicatorsEnabled,
  saveProjectIndicatorsEnabled,
} from '../lib/projectIndicatorSettings'
import {
  DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES,
  MAX_GIT_REFRESH_INTERVAL_START_MINUTES,
  MIN_GIT_REFRESH_INTERVAL_START_MINUTES,
  loadGitRefreshIntervalStartMinutes,
  parseGitRefreshIntervalStartMinutes,
  saveGitRefreshIntervalStartMinutes,
} from '../lib/gitRefreshSettings'
import { checkForAppUpdate, promptAppUpdate } from '../lib/appUpdate'
import {
  SettingsSection as Section,
  SettingItem,
  type SettingsCategoryId as CategoryId,
} from './SettingsLayout'
import TerminalProfilesInline from './TerminalProfilesInline'
import { open, save } from '@tauri-apps/plugin-dialog'
import { authorizePaths } from '../lib/pathAllowlist'
import { exportSettings, importSettings, resetSettings } from '../lib/settingsTransfer'
import { confirmDialog } from '../store/confirmStore'
import { normalizeProjectPath } from '../utils/fileTreeHelpers'

type SettingsScope = 'user' | 'workspace'

/** Survives Strict Mode remounts so a stale deep-link is not reapplied. */
let appliedSettingsFocusSignal = 0

/** Dual-remote git sources shown in 设置 → 关于. Mirrors AGENTS.md. */
const ABOUT_REMOTES: { id: string; label: string; cloneUrl: string; pageUrl: string }[] = [
  {
    id: 'gitee',
    label: 'Gitee',
    cloneUrl: 'https://gitee.com/FrancizTest_admin/qing-code.git',
    pageUrl: 'https://gitee.com/FrancizTest_admin/qing-code',
  },
  {
    id: 'github',
    label: 'GitHub',
    cloneUrl: 'https://github.com/Fracizz/QingCode.git',
    pageUrl: 'https://github.com/Fracizz/QingCode',
  },
]

/** SSH 远端服务设置的搜索关键词：分区可见性与行级过滤共用同一份列表。 */
const SSH_SERVER_SEARCH_TERMS: string[] = [
  '远程连接',
  'SSH 连接',
  'SSH 服务',
  '远端服务',
  '自动下载',
  '离线目录',
  SSH_SERVER_ENABLED_KEY,
  SSH_SERVER_AUTO_DOWNLOAD_KEY,
  SSH_SERVER_OFFLINE_DIR_KEY,
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
  const [category, setCategory] = useState<CategoryId>('appearance')
  const [helpOpen, setHelpOpen] = useState(false)
  const [theme, setThemeState] = useState<AppTheme>(loadTheme)
  const [fonts, setFonts] = useState<FontSettings>(loadFontSettings)
  const [terminal, setTerminal] = useState<TerminalProfileSettings>(loadTerminalProfileSettings)
  const [openingJson, setOpeningJson] = useState(false)
  const [transferBusy, setTransferBusy] = useState(false)
  const [managementMenu, setManagementMenu] = useState<{ x: number; y: number } | null>(null)
  const [scopeDetails, setScopeDetails] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [autoSaveMode, setAutoSaveMode] = useState<AutoSaveMode>('off')
  const [autoSaveDelay, setAutoSaveDelay] = useState<number>(
    DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay'] as number,
  )
  const [minimapEnabled, setMinimapEnabled] = useState(getMinimapEnabled)
  const [sshUploadOnPaste, setSshUploadOnPaste] = useState(getTerminalSshUploadOnPaste)
  const [largePasteAsFile, setLargePasteAsFile] = useState(getTerminalLargePasteAsFile)
  const [persistLocalSessions, setPersistLocalSessions] = useState(getTerminalPersistLocalSessions)
  const [shiftEnterNewline, setShiftEnterNewline] = useState(getTerminalShiftEnterNewline)
  const [activityIndicator, setActivityIndicator] = useState(getTerminalActivityIndicator)
  const [pasteCleanupBusy, setPasteCleanupBusy] = useState(false)
  const [editorGuidesEnabled, setEditorGuidesEnabled] = useState(
    DEFAULT_GLOBAL_SETTINGS['editor.guides.enabled'] !== false,
  )
  const [openWith, setOpenWith] = useState<OpenWithStatus | null>(null)
  const [openWithBusy, setOpenWithBusy] = useState(false)
  const [cliSkillBusy, setCliSkillBusy] = useState(false)
  const [checkOnStartup, setCheckOnStartup] = useState(DEFAULT_UPDATE_SETTINGS.checkOnStartup)
  const [sessionPersist, setSessionPersist] = useState(DEFAULT_SESSION_PERSIST)
  const [editorStateCacheSize, setEditorStateCacheSize] =
    useState<EditorStateCacheSizeSetting>('auto')
  const [editorStateCacheSizeDraft, setEditorStateCacheSizeDraft] = useState(
    String(DEFAULT_EDITOR_STATE_CACHE_SIZE),
  )
  const [editorStateCacheSizeLoaded, setEditorStateCacheSizeLoaded] = useState(false)
  const [projectIndicatorsEnabled, setProjectIndicatorsEnabled] = useState(
    DEFAULT_PROJECT_INDICATORS_ENABLED,
  )
  const [gitRefreshIntervalStartMinutes, setGitRefreshIntervalStartMinutes] = useState(
    DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES,
  )
  const [gitRefreshIntervalStartDraft, setGitRefreshIntervalStartDraft] = useState(
    String(DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES),
  )
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [aboutCopyBusy, setAboutCopyBusy] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const terminalProfilesRef = useRef<HTMLDivElement>(null)
  const categoryNavRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Partial<Record<CategoryId, HTMLElement | null>>>({})
  const onSectionRef = useCallback((id: CategoryId, node: HTMLElement | null) => {
    sectionRefs.current[id] = node
  }, [])

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
    if (!isTauri()) return
    void getOpenWithStatus().then(setOpenWith)
  }, [])

  useEffect(() => {
    void loadUpdateSettings().then(settings => setCheckOnStartup(settings.checkOnStartup))
    void loadSessionPersistEnabled().then(setSessionPersist)
    void loadProjectIndicatorsEnabled().then(setProjectIndicatorsEnabled)
    void loadGitRefreshIntervalStartMinutes().then(value => {
      setGitRefreshIntervalStartMinutes(value)
      setGitRefreshIntervalStartDraft(String(value))
    })
    void loadEditorStateCacheSize()
      .then(value => {
        setEditorStateCacheSize(value)
        setEditorStateCacheSizeDraft(
          String(value === 'auto' ? DEFAULT_EDITOR_STATE_CACHE_SIZE : value),
        )
      })
      .finally(() => setEditorStateCacheSizeLoaded(true))
    void (async () => {
      try {
        if (isTauri()) {
          const { getVersion } = await import('@tauri-apps/api/app')
          setAppVersion(await getVersion())
        } else if (import.meta.env.QINGCODE_VERSION) {
          setAppVersion(import.meta.env.QINGCODE_VERSION)
        }
      } catch {
        // best-effort
      }
    })()
  }, [settingsRevision])

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

  useEffect(() => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    void loadScopedAutoSaveSettings(settingsScope, currentProject).then(settings => {
      setAutoSaveMode(settings.mode)
      setAutoSaveDelay(settings.delay)
    })
    void loadScopedMinimapEnabled(settingsScope, currentProject).then(setMinimapEnabled)
    void loadScopedEditorGuidesEnabled(settingsScope, currentProject).then(
      setEditorGuidesEnabled,
    )
    void loadScopedTerminalSshUploadOnPaste(settingsScope, currentProject).then(
      setSshUploadOnPaste,
    )
    void loadScopedTerminalPersistLocalSessions(settingsScope, currentProject).then(
      setPersistLocalSessions,
    )
    void loadScopedTerminalLargePasteAsFile(settingsScope, currentProject).then(
      setLargePasteAsFile,
    )
    void loadScopedTerminalShiftEnterNewline(settingsScope, currentProject).then(
      setShiftEnterNewline,
    )
    void loadScopedTerminalActivityIndicator(settingsScope, currentProject).then(
      setActivityIndicator,
    )
  }, [scope, currentProject, settingsRevision])

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

  const updateFonts = <K extends keyof FontSettings>(key: K, value: FontSettings[K]) => {
    const next = { ...fonts, [key]: value }
    setFonts(next)
    saveFontSettings(next)
  }

  const updateTerminal = (next: TerminalProfileSettings) => {
    setTerminal(next)
    saveTerminalProfileSettings(next)
  }

  const persistEditorStateCacheSize = async (raw: string) => {
    const parsed = Number(raw)
    const normalized = Math.min(
      MAX_EDITOR_STATE_CACHE_SIZE,
      Math.max(
        MIN_EDITOR_STATE_CACHE_SIZE,
        Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_EDITOR_STATE_CACHE_SIZE,
      ),
    )
    setEditorStateCacheSizeDraft(String(normalized))
    setEditorStateCacheSize(normalized)
    try {
      await saveEditorStateCacheSize(normalized)
    } catch (error) {
      pushToast(
        'error',
        t('保存项目会话 LRU 设置失败: {error}', { error: String(error) }),
      )
    }
  }

  const persistGitRefreshIntervalStartMinutes = async (raw: string) => {
    const intervalStartMinutes = parseGitRefreshIntervalStartMinutes(raw)
    setGitRefreshIntervalStartMinutes(intervalStartMinutes)
    setGitRefreshIntervalStartDraft(String(intervalStartMinutes))
    try {
      await saveGitRefreshIntervalStartMinutes(intervalStartMinutes)
    } catch (error) {
      pushToast(
        'error',
        t('保存 Git 随机刷新周期起始值失败: {error}', { error: String(error) }),
      )
    }
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

  const updateEditorGuidesEnabled = async (enabled: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setEditorGuidesEnabled(enabled)
    try {
      await saveScopedEditorGuidesEnabled(settingsScope, enabled, currentProject)
    } catch (error) {
      pushToast('error', t('保存编辑器参考线设置失败: {error}', { error: String(error) }))
    }
  }

  const updateSshUploadOnPaste = async (enabled: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setSshUploadOnPaste(enabled)
    try {
      await saveScopedTerminalSshUploadOnPaste(settingsScope, enabled, currentProject)
    } catch (error) {
      pushToast('error', t('保存 SSH 终端粘贴上传设置失败: {error}', { error: String(error) }))
    }
  }

  const updatePersistLocalSessions = async (enabled: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setPersistLocalSessions(enabled)
    try {
      await saveScopedTerminalPersistLocalSessions(settingsScope, enabled, currentProject)
    } catch (error) {
      pushToast('error', t('保存本地终端接回设置失败: {error}', { error: String(error) }))
    }
  }

  const updateLargePasteAsFile = async (enabled: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setLargePasteAsFile(enabled)
    try {
      await saveScopedTerminalLargePasteAsFile(settingsScope, enabled, currentProject)
    } catch (error) {
      pushToast('error', t('保存大段粘贴设置失败: {error}', { error: String(error) }))
    }
  }

  const updateShiftEnterNewline = async (enabled: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setShiftEnterNewline(enabled)
    try {
      await saveScopedTerminalShiftEnterNewline(settingsScope, enabled, currentProject)
    } catch (error) {
      pushToast('error', t('保存 Shift+Enter 换行设置失败: {error}', { error: String(error) }))
    }
  }

  const updateActivityIndicator = async (enabled: boolean) => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
    if (settingsScope === 'project' && !currentProject) return
    setActivityIndicator(enabled)
    try {
      await saveScopedTerminalActivityIndicator(settingsScope, enabled, currentProject)
    } catch (error) {
      pushToast('error', t('保存标签运行状态设置失败: {error}', { error: String(error) }))
    }
  }

  const selectCategory = (id: CategoryId) => {
    setQuery('')
    setCategory(id)
  }

  const openSettingsJson = async (writeDefaults = false) => {
    if (!hasBackend()) {
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

  const transferSettings = async (action: 'import' | 'export') => {
    if (!hasBackend()) {
      pushToast('error', t('当前环境无法导入或导出配置'))
      return
    }
    setTransferBusy(true)
    const settingsScope = scope === 'user' ? 'global' : 'project'
    try {
      if (action === 'export') {
        const config = await exportSettings(settingsScope, currentProject)
        const path = await save({
          title: t('导出配置 JSON'),
          defaultPath: settingsScope === 'global'
            ? 'qingcode-user-settings.json'
            : 'qingcode-workspace-settings.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!path) return
        const target = settingsScope === 'global'
          ? await resolveGlobalSettingsPath()
          : await resolveProjectSettingsPath(currentProject!)
        if (normalizeProjectPath(path) === normalizeProjectPath(target)) {
          throw new Error(t('导出文件不能覆盖当前设置文件'))
        }
        if (useEditorStore.getState().getAllTabs().some(
          tab => tab.dirty && normalizeProjectPath(tab.path) === normalizeProjectPath(path),
        )) {
          throw new Error(t('请先保存或撤销设置文件中的未保存修改'))
        }
        await authorizePaths([path])
        await safeInvoke('导出配置', 'write_file', {
          path,
          content: `${JSON.stringify(config, null, 2)}\n`,
        })
        pushToast('success', t('配置已导出'))
      } else {
        const path = await open({
          title: t('导入配置 JSON'),
          directory: false,
          multiple: false,
          filters: [{ name: 'JSON / JSON5', extensions: ['json', 'json5'] }],
        })
        if (!path) return
        await authorizePaths([path])
        const result = await importSettings(
          await safeInvoke<string>('读取配置', 'read_file', { path }),
          settingsScope,
          currentProject,
        )
        if (result.skippedProjects.length) {
          pushToast(
            'info',
            t('配置已导入，{count} 个项目路径不可用', { count: result.skippedProjects.length }),
            result.skippedProjects.join('\n'),
          )
        } else {
          pushToast('success', t('配置已导入并生效'))
        }
      }
    } catch (error) {
      pushToast('error', t('配置操作失败: {error}', {
        error: t(error instanceof Error ? error.message : String(error)),
      }))
    } finally {
      setTransferBusy(false)
    }
  }

  const restoreDefaults = async () => {
    if (!hasBackend()) {
      pushToast('error', t('当前环境无法恢复默认设置'))
      return
    }
    setTransferBusy(true)
    const settingsScope = scope === 'user' ? 'global' : 'project'
    try {
      const confirmed = await confirmDialog({
        title: t('恢复默认设置'),
        message: scope === 'user'
          ? t('将用户设置、主题、字体、语言、快捷键和终端配置恢复为默认值，清空自定义设置。保留项目列表、工作区设置和信任授权。')
          : t('将清空项目「{name}」的工作区设置覆盖项和自定义设置，重新继承用户设置。', { name: currentProject?.name ?? '' }),
        kind: 'warning',
        confirmLabel: t('恢复默认设置'),
        cancelLabel: t('取消'),
      })
      if (!confirmed) return
      await resetSettings(settingsScope, currentProject)
      pushToast('success', t('已恢复默认设置并生效'))
    } catch (error) {
      pushToast('error', t('恢复默认设置失败: {error}', {
        error: t(error instanceof Error ? error.message : String(error)),
      }))
    } finally {
      setTransferBusy(false)
    }
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
              className={`block w-full border-l-2 px-4 py-1.5 text-left text-ui break-words whitespace-normal transition-colors ${
                !q && activeCategory === cat.id
                  ? 'border-brand bg-bg-active text-fg'
                  : 'border-transparent text-fg-muted hover:bg-bg-hover hover:text-fg'
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
                {match('颜色主题', '外观', '深色', '浅色') && (
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
                {match('界面字号') && (
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
                {match('界面字体') && (
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
                )}
                {match('显示语言', '语言') && (
                  <SettingItem
                    title={t('显示语言')}
                    description={t(
                      '选择界面显示语言。更改后立即生效。也可从用户语言包目录加载自定义 JSON。',
                    )}
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
                )}
                {match('自定义语言包', '语言包') && (
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
                        className="setting-control px-2.5 py-1 text-ui-sm"
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
                              pushToast('error', error instanceof Error ? error.message : String(error))
                            }
                          })()
                        }}
                      >
                        {t('刷新语言包')}
                      </button>
                      <button
                        type="button"
                        disabled={workspaceLocked || !isTauri()}
                        className="setting-control px-2.5 py-1 text-ui-sm"
                        onClick={() => {
                          void (async () => {
                            try {
                              const dir = await safeInvoke<string>('读取语言包目录', 'user_locales_dir')
                              await revealItemInDir(dir)
                            } catch (error) {
                              pushToast('error', error instanceof Error ? error.message : String(error))
                            }
                          })()
                        }}
                      >
                        {t('打开语言包目录')}
                      </button>
                    </div>
                  </SettingItem>
                )}
              </Section>
            )}

            {sectionVisible('editor') && (
              <Section id="editor" title={t('编辑器与文件')} onSectionRef={onSectionRef}>
                {match('参考线', '缩进线', '括号线', 'editor.guides.enabled') && (
                  <SettingItem
                    title={t('编辑器: 参考线')}
                    description={t('控制普通缩进线、活动高亮线和括号参考线。关闭后这些线全部隐藏。')}
                    modified={editorGuidesEnabled !== DEFAULT_GLOBAL_SETTINGS['editor.guides.enabled']}
                    locked={scope === 'workspace' && !currentProject}
                    lockHint={t('请先选择项目，再配置工作区编辑器参考线。')}
                  >
                    <select
                      value={editorGuidesEnabled ? 'on' : 'off'}
                      disabled={scope === 'workspace' && !currentProject}
                      onChange={e => void updateEditorGuidesEnabled(e.target.value === 'on')}
                      className="setting-control setting-select"
                      aria-label={t('编辑器: 参考线')}
                    >
                      <option value="on">{t('开启')}</option>
                      <option value="off">{t('关闭')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('小地图', 'minimap', 'editor.minimap.enabled') && (
                  <SettingItem
                    title={t('编辑器: 小地图')}
                    description={t('在编辑区右侧显示代码缩略图，便于快速跳转。大于 5MB 的文件会自动隐藏。')}
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
                          onChange={e => void updateAutoSave(autoSaveMode, Number(e.target.value))}
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
                {!workspaceLocked && match('代码字体', '编辑器字号') && (
                  <>
                    <SettingItem
                      title={t('编辑器: 字体族')}
                      description={t('控制编辑器字体族。可选择本机已安装字体。')}
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
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </SettingItem>
                  </>
                )}
                {match(
                  '打开设置 JSON',
                  'JSON5',
                  'files.exclude',
                  'search.exclude',
                  'files.encoding',
                  'files.eol',
                  'editor.tabSize',
                  'editor.wordWrap',
                  '不计划',
                ) && (
                  <SettingItem
                    title={t('JSON 键生效说明')}
                    description={t(
                      'files.exclude / search.exclude / useIgnoreFiles / followSymlinks、explorer.excludeGitIgnore、files.encoding、editor.minimap.enabled、editor.formatOnSave / formatOnPaste、括号着色与参考线、terminal.integrated.scrollback / cursorBlinking / sshUploadOnPaste 已生效。标有「不计划」的键（如 linkedEditing）会保存但不会改变行为。详见帮助文档。',
                    )}
                  >
                    <span className="text-ui-sm text-fg-dim">{t('管理设置 → 打开设置 JSON')}</span>
                  </SettingItem>
                )}
              </Section>
            )}

            {sectionVisible('terminal') && (
              <Section id="terminal" title={t('终端')} onSectionRef={onSectionRef}>
                {!workspaceLocked && match('终端字体', 'terminal.integrated.fontFamily') && (
                  <SettingItem
                    title={t('终端 › 集成: 字体族')}
                    description={t(
                      '独立设置终端字体族，默认使用系统等宽字体。可选择本机全部已安装字体，修改后立即生效。',
                    )}
                    modified={fonts.terminalFont !== DEFAULT_FONT_SETTINGS.terminalFont}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <FontFamilySelect
                      value={fonts.terminalFont}
                      presets={TERMINAL_FONT_OPTIONS}
                      kind="terminal"
                      disabled={workspaceLocked}
                      aria-label={t('终端 › 集成: 字体族')}
                      onChange={value => updateFonts('terminalFont', value)}
                    />
                  </SettingItem>
                )}
                {!workspaceLocked && match('终端字号', 'terminal.integrated.fontSize') && (
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
                      {/* Ctrl + 滚轮可缩放到预设之外的字号，当前值也要能显示。 */}
                      {[...new Set<number>([...FONT_SIZE_OPTIONS, fonts.terminalFontSize])].sort((a, b) => a - b).map(size => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </SettingItem>
                )}
                {!workspaceLocked && match('默认 Shell', 'pwsh', 'WSL', 'Zsh') && (
                  <SettingItem
                    title={t('终端 › 集成: 默认 Shell')}
                    description={t(
                      '新建「普通终端」时使用的主机 Shell（全局）。Windows 默认自动选择 PowerShell 7、Windows PowerShell 或 CMD；macOS/Linux 默认 Zsh。自定义配置可单独指定 Shell。',
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
                )}
                {!workspaceLocked && match('终端配置', '默认启动配置') && (
                  <div ref={terminalProfilesRef} className="scroll-mt-4 pl-3 border-l-2 border-transparent">
                    <TerminalProfilesInline settings={terminal} onChange={updateTerminal} />
                  </div>
                )}
                {match('SSH', '粘贴', '上传', 'sshUploadOnPaste') && (
                  <SettingItem
                    title={t('终端 › 集成: SSH 粘贴上传')}
                    description={t(
                      '在 SSH 终端粘贴或拖入本机文件时，先上传到项目 .qingcode/terminal-paste/，再粘贴远端路径。默认开启。超过 100MB 的文件或文件夹会被拒绝。',
                    )}
                    modified={
                      sshUploadOnPaste !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.sshUploadOnPaste']
                    }
                  >
                    <select
                      value={sshUploadOnPaste ? 'on' : 'off'}
                      onChange={e => void updateSshUploadOnPaste(e.target.value === 'on')}
                      className="setting-control setting-select"
                      aria-label={t('终端 › 集成: SSH 粘贴上传')}
                    >
                      <option value="off">{t('关闭')}</option>
                      <option value="on">{t('开启')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('粘贴', '大段', '文件', 'largePasteAsFile') && (
                  <SettingItem
                    title={t('终端 › 集成: 大段粘贴存为文件')}
                    description={t(
                      '粘贴超过 32KB 或 500 行的文本时，不再询问，直接存为文件并只粘贴文件路径，避免 Claude Code 等终端程序卡顿。关闭时每次询问。SSH 终端需同时开启粘贴上传。',
                    )}
                    modified={
                      largePasteAsFile !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.largePasteAsFile']
                    }
                  >
                    <select
                      value={largePasteAsFile ? 'on' : 'off'}
                      onChange={e => void updateLargePasteAsFile(e.target.value === 'on')}
                      className="setting-control setting-select"
                      aria-label={t('终端 › 集成: 大段粘贴存为文件')}
                    >
                      <option value="off">{t('关闭')}</option>
                      <option value="on">{t('开启')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('持久', '接回', '保留', '本地终端', 'persistLocalSessions') && (
                  <SettingItem
                    title={t('终端 › 集成: 本地终端可接回')}
                    description={t(
                      '新建的本地终端由后台宿主进程托管，关闭或升级 QingCode 后进程继续运行，下次打开时接回。仅 Windows 的 PowerShell 和 CMD 终端支持；一次性运行任务和 WSL 终端不受影响。电脑重启后终端会按原配置重新启动，连续断开 24 小时后自动结束。',
                    )}
                    modified={
                      persistLocalSessions !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.persistLocalSessions']
                    }
                  >
                    <select
                      value={persistLocalSessions ? 'on' : 'off'}
                      onChange={e => void updatePersistLocalSessions(e.target.value === 'on')}
                      className="setting-control setting-select"
                      aria-label={t('终端 › 集成: 本地终端可接回')}
                    >
                      <option value="off">{t('关闭')}</option>
                      <option value="on">{t('开启')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('Shift+Enter', '换行', 'Agent', 'shiftEnterNewline') && (
                  <SettingItem
                    title={t('终端 › 集成: Shift+Enter 换行')}
                    description={t(
                      '在 Claude Code、Codex、OpenCode 等 Agent 或全屏 TUI 中，Shift+Enter 换行而不提交。普通 Shell 不受影响。Ctrl+Enter 始终换行。',
                    )}
                    modified={
                      shiftEnterNewline !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.shiftEnterNewline']
                    }
                  >
                    <select
                      value={shiftEnterNewline ? 'on' : 'off'}
                      onChange={e => void updateShiftEnterNewline(e.target.value === 'on')}
                      className="setting-control setting-select"
                      aria-label={t('终端 › 集成: Shift+Enter 换行')}
                    >
                      <option value="on">{t('开启')}</option>
                      <option value="off">{t('关闭')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('状态', '运行中', 'tabActivityIndicator') && (
                  <SettingItem
                    title={t('终端 › 集成: 标签运行状态')}
                    description={t(
                      '在终端标签上显示「运行中」呼吸点：程序标题在转圈，或持续输出约 1 秒以上时亮起，停止约 3 秒后熄灭。由输出事件驱动，不轮询进程；不出声的长命令（如静默编译）不会亮。',
                    )}
                    modified={
                      activityIndicator !== DEFAULT_GLOBAL_SETTINGS['terminal.integrated.tabActivityIndicator']
                    }
                  >
                    <select
                      value={activityIndicator ? 'on' : 'off'}
                      onChange={e => void updateActivityIndicator(e.target.value === 'on')}
                      className="setting-control setting-select"
                      aria-label={t('终端 › 集成: 标签运行状态')}
                    >
                      <option value="off">{t('关闭')}</option>
                      <option value="on">{t('开启')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('清理远程粘贴文件', 'terminal-paste') && (
                  <SettingItem
                    title={t('清理远程粘贴文件')}
                    description={t(
                      '删除当前 SSH 项目的 .qingcode/terminal-paste 目录。终端里已经粘贴的路径会失效。',
                    )}
                  >
                    <button
                      type="button"
                      disabled={pasteCleanupBusy || !currentProject || !isSshProject(currentProject)}
                      className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                      aria-label={t('清理远程粘贴文件')}
                      onClick={() => {
                        if (!currentProject || !isSshProject(currentProject)) return
                        setPasteCleanupBusy(true)
                        void confirmClearSshTerminalPasteUploads(currentProject.path).finally(() =>
                          setPasteCleanupBusy(false),
                        )
                      }}
                    >
                      {t('清理')}
                    </button>
                  </SettingItem>
                )}
              </Section>
            )}

            {sectionVisible('projects') && (
              <Section id="projects" title={t('项目与会话')} onSectionRef={onSectionRef}>
                {match('会话状态', '会话状态保存', '会话') && (
                  <SettingItem
                    title={t('会话状态保存')}
                    description={t(
                      '重启后恢复编辑器标签、终端与运行配置关联。关闭后不再保存或恢复，并清除已缓存的会话快照。',
                    )}
                    modified={sessionPersist !== DEFAULT_SESSION_PERSIST}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <select
                      value={sessionPersist ? 'on' : 'off'}
                      disabled={workspaceLocked}
                      onChange={e => {
                        const enabled = e.target.value === 'on'
                        setSessionPersist(enabled)
                        void saveSessionPersistEnabled(enabled).catch(error =>
                          pushToast('error', t('保存会话设置失败: {error}', { error: String(error) })),
                        )
                      }}
                      className="setting-control setting-select"
                    >
                      <option value="on">{t('开启')}</option>
                      <option value="off">{t('关闭')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('项目会话 LRU', '编辑器状态缓存', '会话', 'LRU') && (
                  <>
                    <SettingItem
                      title={t('项目会话 LRU 个数')}
                      description={t(
                        '控制跨标签和项目会话保留的编辑器状态数量（撤销栈、选区与折叠状态）。超过数量后优先淘汰最久未使用的状态，不会丢失文件内容。',
                      )}
                      modified={editorStateCacheSize !== 'auto'}
                      locked={workspaceLocked}
                      lockHint={t('此设置仅在用户作用域中可用')}
                    >
                      <select
                        aria-label={t('项目会话 LRU 个数')}
                        value={editorStateCacheSize === 'auto' ? 'auto' : 'custom'}
                        disabled={workspaceLocked || !editorStateCacheSizeLoaded}
                        onChange={e => {
                          if (e.target.value === 'auto') {
                            setEditorStateCacheSize('auto')
                            setEditorStateCacheSizeDraft(String(DEFAULT_EDITOR_STATE_CACHE_SIZE))
                            void saveEditorStateCacheSize('auto').catch(error =>
                              pushToast(
                                'error',
                                t('保存项目会话 LRU 设置失败: {error}', {
                                  error: String(error),
                                }),
                              ),
                            )
                            return
                          }
                          setEditorStateCacheSize(DEFAULT_EDITOR_STATE_CACHE_SIZE)
                          setEditorStateCacheSizeDraft(String(DEFAULT_EDITOR_STATE_CACHE_SIZE))
                          void saveEditorStateCacheSize(DEFAULT_EDITOR_STATE_CACHE_SIZE).catch(error =>
                            pushToast(
                              'error',
                              t('保存项目会话 LRU 设置失败: {error}', {
                                error: String(error),
                              }),
                            ),
                          )
                        }}
                        className="setting-control setting-select"
                      >
                        <option value="auto">
                          {t('自动（默认 {count} 个）', {
                            count: DEFAULT_EDITOR_STATE_CACHE_SIZE,
                          })}
                        </option>
                        <option value="custom">{t('自定义')}</option>
                      </select>
                    </SettingItem>
                    {editorStateCacheSize !== 'auto' && (
                      <SettingItem
                        title={t('项目会话 LRU 自定义个数')}
                        description={t('可设为 {min}–{max} 个；失去焦点或按 Enter 后保存。', {
                          min: MIN_EDITOR_STATE_CACHE_SIZE,
                          max: MAX_EDITOR_STATE_CACHE_SIZE,
                        })}
                        modified
                        locked={workspaceLocked}
                        lockHint={t('此设置仅在用户作用域中可用')}
                      >
                        <input
                          aria-label={t('项目会话 LRU 自定义个数')}
                          type="number"
                          min={MIN_EDITOR_STATE_CACHE_SIZE}
                          max={MAX_EDITOR_STATE_CACHE_SIZE}
                          step={1}
                          value={editorStateCacheSizeDraft}
                          disabled={workspaceLocked}
                          onChange={e => setEditorStateCacheSizeDraft(e.target.value)}
                          onBlur={() => void persistEditorStateCacheSize(editorStateCacheSizeDraft)}
                          onKeyDown={e => {
                            if (e.key !== 'Enter') return
                            e.currentTarget.blur()
                          }}
                          className="setting-control w-28 px-2 py-1 text-right"
                        />
                      </SettingItem>
                    )}
                  </>
                )}
                {match('项目角标', '顶栏项目角标', '项目指示') && (
                  <SettingItem
                    title={t('顶栏项目角标')}
                    description={t(
                      '在顶栏项目名称旁显示运行中终端、未保存文件与 Git 更改角标。终端与未保存状态随编辑实时更新；Git 数量按已配置的随机刷新周期轮询，窗口重新聚焦或 Git 状态变更时也会刷新。关闭后隐藏角标，并停止角标使用的多项目 Git 轮询。',
                    )}
                    modified={projectIndicatorsEnabled !== DEFAULT_PROJECT_INDICATORS_ENABLED}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <select
                      value={projectIndicatorsEnabled ? 'on' : 'off'}
                      disabled={workspaceLocked}
                      onChange={e => {
                        const enabled = e.target.value === 'on'
                        setProjectIndicatorsEnabled(enabled)
                        void saveProjectIndicatorsEnabled(enabled).catch(error =>
                          pushToast('error', t('保存项目角标设置失败: {error}', { error: String(error) })),
                        )
                      }}
                      className="setting-control setting-select"
                    >
                      <option value="on">{t('开启')}</option>
                      <option value="off">{t('关闭')}</option>
                    </select>
                  </SettingItem>
                )}
                {match('Git 随机刷新周期起始值', 'Git 刷新周期起始值', 'Git', '刷新', '分钟') && (
                  <SettingItem
                    title={t('Git 随机刷新周期起始值（分钟）')}
                    description={t(
                      '设置每个项目随机 Git 轮询周期的起始值。最小值和默认值均为 5 分钟；实际周期在起始值至其 1.5 倍（向上取整）之间随机选择整分钟。顶栏多项目刷新按随机顺序逐个执行，不会同时并发刷新全部项目；即时刷新不受影响。',
                    )}
                    modified={gitRefreshIntervalStartMinutes !== DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <label
                      className="setting-control setting-number-with-unit"
                      aria-disabled={workspaceLocked}
                    >
                      <input
                        aria-label={t('Git 随机刷新周期起始值（分钟）')}
                        type="number"
                        min={MIN_GIT_REFRESH_INTERVAL_START_MINUTES}
                        max={MAX_GIT_REFRESH_INTERVAL_START_MINUTES}
                        step={1}
                        value={gitRefreshIntervalStartDraft}
                        disabled={workspaceLocked}
                        onChange={e => setGitRefreshIntervalStartDraft(e.target.value)}
                        onBlur={() =>
                          void persistGitRefreshIntervalStartMinutes(gitRefreshIntervalStartDraft)
                        }
                        onKeyDown={e => {
                          if (e.key !== 'Enter') return
                          e.currentTarget.blur()
                        }}
                        className="setting-number-with-unit-input"
                      />
                      <span className="shrink-0 text-ui-sm text-fg-muted">{t('分钟')}</span>
                    </label>
                  </SettingItem>
                )}
              </Section>
            )}

            {sectionVisible('remote') && (
              <Section id="remote" title={t('远程连接')} onSectionRef={onSectionRef}>
                {!workspaceLocked && match('远程连接', 'SSH 连接') && (
                  <SettingItem
                    title={t('远程连接')}
                    description={t(
                      '集中管理 SSH 主机：新建、编辑、测试连接、断开，并查看挂在主机下的远程项目与远端服务。',
                    )}
                  >
                    <button
                      type="button"
                      className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60"
                      onClick={() => useUIStore.getState().openRemoteConnections()}
                    >
                      {t('管理远程连接…')}
                    </button>
                  </SettingItem>
                )}
                {match(...SSH_SERVER_SEARCH_TERMS) && (
                  <SshServerSettingsSection
                    scope={scope}
                    project={currentProject}
                    settingsRevision={settingsRevision}
                  />
                )}
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
                {match('AI CLI skills', 'AI', 'CLI', 'skills', 'Agent', 'qingcode-cli') && (
                  <SettingItem
                    title={t('AI CLI skills')}
                    description={t(
                      '复制 QingCode CLI 的 skills 文本到剪贴板。请按你使用的 AI Agent 文档自行安装（例如保存为 skills.md），QingCode 不会自动适配或注册任何 Agent。',
                    )}
                    modified={false}
                    locked={workspaceLocked}
                    lockHint={t('此设置仅在用户作用域中可用')}
                  >
                    <button
                      type="button"
                      disabled={cliSkillBusy || workspaceLocked}
                      className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                      onClick={() => {
                        setCliSkillBusy(true)
                        void (async () => {
                          try {
                            let exe =
                              (isTauri() ? await safeInvoke<string>('获取程序路径', 'cli_exe_path') : '') ||
                              openWith?.exe_path?.trim() ||
                              ''
                            if (!exe.trim()) exe = 'QingCode.exe'
                            await copyToClipboard(buildQingcodeCliSkillMarkdown(exe, language))
                            pushToast('success', t('已复制 CLI skills，请粘贴到你的 AI Agent 中安装。'))
                          } catch (error) {
                            pushToast('error', t('复制失败: {error}', { error: String(error) }))
                          } finally {
                            setCliSkillBusy(false)
                          }
                        })()
                      }}
                    >
                      {cliSkillBusy ? t('正在复制…') : t('复制 skills 文本')}
                    </button>
                  </SettingItem>
                )}
                {isWindows && match('打开方式', 'Open with', 'Windows') && (
                  <SettingItem
                    title={t('Windows 打开方式')}
                    description={t(
                      '将 QingCode 添加到资源管理器「打开方式」菜单，不改变默认程序。排除 .bat/.cmd 执行关联；取消注册后保留已经选择的默认程序。无需管理员权限。',
                    )}
                    modified={Boolean(openWith?.registered)}
                  >
                    <div className="flex flex-col items-end gap-2 max-w-md">
                      {!isTauri() || openWith?.supported === false ? (
                        <span className="text-ui-sm text-fg-dim">{t('仅 Windows 桌面版支持此功能。')}</span>
                      ) : (
                        <>
                          <span className="text-ui-sm text-right text-fg-muted">
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
                              <span className="text-ui-sm block max-w-full truncate font-mono text-fg-dim">
                                {t('当前程序：{path}', { path: openWith.exe_path })}
                              </span>
                            </Tooltip>
                          ) : null}
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              disabled={openWithBusy}
                              className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
                              onClick={() => {
                                setOpenWithBusy(true)
                                void registerOpenWith()
                                  .then(status => {
                                    setOpenWith(status)
                                    pushToast(
                                      'success',
                                      t('注册成功。可在资源管理器中右键文件 → 打开方式 → QingCode。'),
                                    )
                                  })
                                  .catch(error =>
                                    pushToast('error', t('注册失败: {error}', { error: String(error) })),
                                  )
                                  .finally(() => setOpenWithBusy(false))
                              }}
                            >
                              {t('注册「打开方式」')}
                            </button>
                            <button
                              type="button"
                              disabled={openWithBusy || !openWith?.registered}
                              className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
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
              </Section>
            )}

            {sectionVisible('shortcuts') && (
              <Section id="shortcuts" title={t('快捷键')} onSectionRef={onSectionRef}>
                <SettingItem
                  title={t('键盘快捷方式')}
                  description={t('自定义常用操作的按键组合。')}
                  modified={Object.keys(DEFAULT_SHORTCUTS).some(
                    key => shortcuts[key as ShortcutCommand] !== DEFAULT_SHORTCUTS[key as ShortcutCommand],
                  )}
                >
                  <span className="text-ui-sm text-fg-dim">{t('见下方列表')}</span>
                </SettingItem>
                <div className="pl-3">
                  <ShortcutSettings query={q} />
                </div>
              </Section>
            )}

            {sectionVisible('about') && (
              <Section id="about" title={t('更新与关于')} onSectionRef={onSectionRef}>
                {match('检查更新', '自动检查更新', '更新') && (
                  <>
                    <SettingItem
                      title={t('启动时自动检查更新')}
                      description={t(
                        '正式构建启动后约 3 秒静默查询 GitHub / Gitee Release。关闭后仍可手动检查。',
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
                            pushToast('error', t('保存更新设置失败: {error}', { error: String(error) })),
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
                      description={t('查询远端最新安装包；发现新版本时可下载安装包，不会自动安装。')}
                      modified={false}
                      locked={workspaceLocked}
                      lockHint={t('此设置仅在用户作用域中可用')}
                    >
                      <button
                        type="button"
                        disabled={updateCheckBusy || !isTauri() || workspaceLocked}
                        className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60 disabled:opacity-40"
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
                              pushToast('error', t('检查更新失败: {error}', { error: String(error) })),
                            )
                            .finally(() => setUpdateCheckBusy(false))
                        }}
                      >
                        {updateCheckBusy ? t('正在检查…') : t('检查更新')}
                      </button>
                    </SettingItem>
                  </>
                )}
                {match('关于', '版本', 'QingCode') && (
                  <SettingItem
                    title={t('QingCode')}
                    description={t(
                      '轻量级多项目代码编辑器，Tauri 2 + React 19 + Rust。采用 MIT 开源协议。',
                    )}
                    modified={false}
                  >
                    <div className="text-right">
                      <span className="text-ui-sm text-fg-muted">
                        {appVersion ? `v${appVersion}` : t('版本未知')}
                      </span>
                    </div>
                  </SettingItem>
                )}
                {match('源代码仓库', '仓库', 'Gitee', 'GitHub', 'git') && (
                  <SettingItem
                    title={t('源代码仓库')}
                    description={t(
                      'QingCode 在 Gitee 与 GitHub 双端镜像维护。点击打开远端页面，或复制克隆地址。',
                    )}
                    modified={false}
                  >
                    <div className="flex flex-col items-stretch gap-2 w-full">
                      {ABOUT_REMOTES.map(remote => (
                        <div
                          key={remote.id}
                          className="flex items-center gap-2 rounded border border-border px-2.5 py-1.5"
                        >
                          <span className="text-ui-sm font-medium text-fg flex-shrink-0 w-14">
                            {remote.label}
                          </span>
                          <code className="flex-1 min-w-0 truncate font-mono text-ui-sm text-fg-muted">
                            {remote.cloneUrl}
                          </code>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <Tooltip label={t('复制克隆地址')} side="top">
                              <button
                                type="button"
                                disabled={aboutCopyBusy === remote.id}
                                onClick={() => {
                                  setAboutCopyBusy(remote.id)
                                  void copyToClipboard(remote.cloneUrl)
                                    .then(() =>
                                      pushToast(
                                        'success',
                                        t('已复制 {label} 克隆地址', { label: remote.label }),
                                      ),
                                    )
                                    .catch(error =>
                                      pushToast('error', t('复制失败: {error}', { error: String(error) })),
                                    )
                                    .finally(() => setAboutCopyBusy(null))
                                }}
                                className="inline-flex h-6 shrink-0 items-center justify-center rounded px-2 text-ui-sm whitespace-nowrap text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                                aria-label={t('复制克隆地址')}
                              >
                                {aboutCopyBusy === remote.id ? '…' : t('复制')}
                              </button>
                            </Tooltip>
                            <Tooltip label={t('打开 {label} 页面', { label: remote.label })} side="top">
                              <button
                                type="button"
                                onClick={() => {
                                  void openUrl(remote.pageUrl).catch(error =>
                                    pushToast(
                                      'error',
                                      t('打开链接失败: {error}', { error: String(error) }),
                                    ),
                                  )
                                }}
                                className="inline-flex h-6 shrink-0 items-center justify-center rounded px-2 text-ui-sm whitespace-nowrap text-fg-muted hover:bg-bg-hover hover:text-fg"
                              >
                                {t('打开')}
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      ))}
                    </div>
                  </SettingItem>
                )}
                {match('协议', 'License', 'MIT', '开源') && (
                  <SettingItem
                    title={t('协议')}
                    description={t('MIT License — 自由使用、修改与分发，需保留版权声明。')}
                    modified={false}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        void openUrl('https://github.com/Fracizz/QingCode/blob/master/LICENSE').catch(
                          error => pushToast('error', t('打开链接失败: {error}', { error: String(error) })),
                        )
                      }}
                      className="setting-control px-2.5 py-1 text-ui-sm border border-border-strong rounded hover:border-accent/60"
                    >
                      {t('查看 LICENSE')}
                    </button>
                  </SettingItem>
                )}
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
