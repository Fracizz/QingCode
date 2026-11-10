/**
 * 设置页各分区的状态与持久化逻辑。
 *
 * 这些 hook 由 SettingsEditor 在顶层调用（而不是放进分区组件内部），
 * 保证切换分类 / 搜索导致分区卸载时状态不丢失、不重复读盘，加载时机与拆分前一致。
 */
import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { isTauri } from '../../lib/tauri'
import { useProjectStore } from '../../store/projectStore'
import type { Project } from '../../types'
import { DEFAULT_GLOBAL_SETTINGS } from '../../lib/projectSettings'
import {
  loadScopedAutoSaveSettings,
  saveScopedAutoSaveSettings,
  type AutoSaveMode,
} from '../../lib/autoSaveSettings'
import {
  getMinimapEnabled,
  loadScopedMinimapEnabled,
  saveScopedMinimapEnabled,
} from '../../lib/minimapSettings'
import {
  loadScopedEditorGuidesEnabled,
  saveScopedEditorGuidesEnabled,
} from '../../lib/editorSettings'
import {
  getTerminalSshUploadOnPaste,
  loadScopedTerminalSshUploadOnPaste,
  saveScopedTerminalSshUploadOnPaste,
} from '../../lib/terminal/terminalSshUploadSettings'
import {
  getTerminalShiftEnterNewline,
  loadScopedTerminalShiftEnterNewline,
  saveScopedTerminalShiftEnterNewline,
} from '../../lib/terminal/terminalShiftEnterSettings'
import {
  getTerminalPersistLocalSessions,
  loadScopedTerminalPersistLocalSessions,
  saveScopedTerminalPersistLocalSessions,
} from '../../lib/terminal/terminalPersistLocalSettings'
import {
  getTerminalLargePasteAsFile,
  loadScopedTerminalLargePasteAsFile,
  saveScopedTerminalLargePasteAsFile,
} from '../../lib/terminal/terminalLargePasteSettings'
import {
  getTerminalActivityIndicator,
  loadScopedTerminalActivityIndicator,
  saveScopedTerminalActivityIndicator,
} from '../../lib/terminal/terminalActivitySettings'
import {
  DEFAULT_UPDATE_SETTINGS,
  loadUpdateSettings,
} from '../../lib/updateSettings'
import {
  DEFAULT_SESSION_PERSIST,
  loadSessionPersistEnabled,
} from '../../lib/sessionPersistSettings'
import {
  DEFAULT_EDITOR_STATE_CACHE_SIZE,
  MAX_EDITOR_STATE_CACHE_SIZE,
  MIN_EDITOR_STATE_CACHE_SIZE,
  loadEditorStateCacheSize,
  saveEditorStateCacheSize,
  type EditorStateCacheSizeSetting,
} from '../../lib/editorStateCacheSettings'
import {
  DEFAULT_PROJECT_INDICATORS_ENABLED,
  loadProjectIndicatorsEnabled,
} from '../../lib/projectIndicatorSettings'
import {
  DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES,
  loadGitRefreshIntervalStartMinutes,
  parseGitRefreshIntervalStartMinutes,
  saveGitRefreshIntervalStartMinutes,
} from '../../lib/gitRefreshSettings'
import { getOpenWithStatus, type OpenWithStatus } from '../../lib/openWithSettings'
import type { SettingsScope } from './types'

/** 编辑器与文件分区：自动保存、小地图、参考线（随作用域读写）。 */
export function useEditorFileSettings(
  scope: SettingsScope,
  currentProject: Project | null,
  settingsRevision: number,
) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const [autoSaveMode, setAutoSaveMode] = useState<AutoSaveMode>('off')
  const [autoSaveDelay, setAutoSaveDelay] = useState<number>(
    DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay'] as number,
  )
  const [minimapEnabled, setMinimapEnabled] = useState(getMinimapEnabled)
  const [editorGuidesEnabled, setEditorGuidesEnabled] = useState(
    DEFAULT_GLOBAL_SETTINGS['editor.guides.enabled'] !== false,
  )

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
  }, [scope, currentProject, settingsRevision])

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

  return {
    autoSaveMode,
    autoSaveDelay,
    minimapEnabled,
    editorGuidesEnabled,
    updateAutoSave,
    updateMinimapEnabled,
    updateEditorGuidesEnabled,
  }
}

export type EditorFileSettingsState = ReturnType<typeof useEditorFileSettings>

/** 终端分区：SSH 粘贴上传、大段粘贴、本地终端接回、Shift+Enter、运行状态（随作用域读写）。 */
export function useTerminalIntegrationSettings(
  scope: SettingsScope,
  currentProject: Project | null,
  settingsRevision: number,
) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
  const [sshUploadOnPaste, setSshUploadOnPaste] = useState(getTerminalSshUploadOnPaste)
  const [largePasteAsFile, setLargePasteAsFile] = useState(getTerminalLargePasteAsFile)
  const [persistLocalSessions, setPersistLocalSessions] = useState(getTerminalPersistLocalSessions)
  const [shiftEnterNewline, setShiftEnterNewline] = useState(getTerminalShiftEnterNewline)
  const [activityIndicator, setActivityIndicator] = useState(getTerminalActivityIndicator)
  const [pasteCleanupBusy, setPasteCleanupBusy] = useState(false)

  useEffect(() => {
    const settingsScope = scope === 'workspace' ? 'project' : 'global'
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

  return {
    sshUploadOnPaste,
    largePasteAsFile,
    persistLocalSessions,
    shiftEnterNewline,
    activityIndicator,
    pasteCleanupBusy,
    setPasteCleanupBusy,
    updateSshUploadOnPaste,
    updatePersistLocalSessions,
    updateLargePasteAsFile,
    updateShiftEnterNewline,
    updateActivityIndicator,
  }
}

export type TerminalIntegrationSettingsState = ReturnType<typeof useTerminalIntegrationSettings>

/** 项目与会话分区：会话保存、编辑器状态 LRU、顶栏角标、Git 刷新周期（仅用户作用域）。 */
export function useProjectSessionSettings(settingsRevision: number) {
  const { t } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)
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

  useEffect(() => {
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
  }, [settingsRevision])

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

  return {
    sessionPersist,
    setSessionPersist,
    editorStateCacheSize,
    setEditorStateCacheSize,
    editorStateCacheSizeDraft,
    setEditorStateCacheSizeDraft,
    editorStateCacheSizeLoaded,
    projectIndicatorsEnabled,
    setProjectIndicatorsEnabled,
    gitRefreshIntervalStartMinutes,
    gitRefreshIntervalStartDraft,
    setGitRefreshIntervalStartDraft,
    persistEditorStateCacheSize,
    persistGitRefreshIntervalStartMinutes,
  }
}

export type ProjectSessionSettingsState = ReturnType<typeof useProjectSessionSettings>

/** 工具与集成分区：Windows 打开方式注册状态、CLI skills 复制。 */
export function useToolsIntegrationSettings() {
  const [openWith, setOpenWith] = useState<OpenWithStatus | null>(null)
  const [openWithBusy, setOpenWithBusy] = useState(false)
  const [cliSkillBusy, setCliSkillBusy] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    void getOpenWithStatus().then(setOpenWith)
  }, [])

  return { openWith, setOpenWith, openWithBusy, setOpenWithBusy, cliSkillBusy, setCliSkillBusy }
}

export type ToolsIntegrationSettingsState = ReturnType<typeof useToolsIntegrationSettings>

/** 更新与关于分区：启动检查更新开关、应用版本、按钮忙碌态。 */
export function useAboutSettings(settingsRevision: number) {
  const [checkOnStartup, setCheckOnStartup] = useState(DEFAULT_UPDATE_SETTINGS.checkOnStartup)
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [aboutCopyBusy, setAboutCopyBusy] = useState<string | null>(null)

  useEffect(() => {
    void loadUpdateSettings().then(settings => setCheckOnStartup(settings.checkOnStartup))
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

  return {
    checkOnStartup,
    setCheckOnStartup,
    updateCheckBusy,
    setUpdateCheckBusy,
    appVersion,
    aboutCopyBusy,
    setAboutCopyBusy,
  }
}

export type AboutSettingsState = ReturnType<typeof useAboutSettings>
