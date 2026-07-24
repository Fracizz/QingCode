import { useEffect, useRef, useState } from 'react'
import { GitBranch, Folder, Terminal as TerminalIcon, ShieldAlert } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { formatTerminalName } from '../utils/terminalName'
import StatusTip from './StatusTip'
import { useI18n } from '../lib/i18n'
import { isTauri, safeInvoke } from '../lib/tauri'
import {
  isProjectRestricted,
  WORKSPACE_TRUST_CHANGED_EVENT,
} from '../lib/workspaceTrust'
import { useGitStatusStore } from '../store/gitStatusStore'
import { peekSourceControlCache, useSourceControlStore } from '../store/sourceControlStore'
import ContextMenu from './ContextMenu'
import {
  FILE_ENCODING_OPTIONS,
  REOPEN_FILE_ENCODING_OPTIONS,
  formatFileEncoding,
} from '../lib/fileEncoding'
import { checkForAppUpdate } from '../lib/appUpdate'
import { formatAppMemoryMb } from '../lib/appMemory'
import { readStatusBarRowTop, STATUS_BAR_ROW_ATTR, StatusBarRowContext } from './statusBarRowContext'

type GitHeadInfo = {
  name: string
  detached: boolean
}

type AppMemoryInfo = {
  totalBytes: number
  mainBytes: number
  webviewBytes: number
  terminalBytes: number
}

const GIT_HEAD_REFRESH_MS = 15_000
/** Background poll while the window is visible. */
const APP_MEMORY_REFRESH_MS = 10_000
/** Faster poll while the memory tip is open. */
const APP_MEMORY_TIP_REFRESH_MS = 5_000

/** Subtle vertical rule between logical status-bar groups. */
function StatusDivider() {
  return <span className="mx-1.5 h-3 w-px flex-shrink-0 bg-border" aria-hidden />
}

/** Clickable status-bar chips: primary text, hover lift only — never accent fill. */
const STATUS_ACTION =
  'rounded px-1 -mx-1 text-fg hover:bg-bg-hover transition-colors'
/** Secondary / meta copy: brighter than global fg-muted for 24px bar readability. */
const STATUS_SECONDARY = 'text-fg/85'

export default function StatusBar() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const cursor = useEditorStore(s => s.cursor)
  const setTabEncoding = useEditorStore(s => s.setTabEncoding)
  const reopenWithEncoding = useEditorStore(s => s.reopenWithEncoding)
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const secondaryTerminalId = useTerminalStore(s => s.secondaryTerminalId)
  const terminalFocusPane = useTerminalStore(s => s.terminalFocusPane)
  const setView = useUIStore(s => s.setView)
  const requestToggleTerminal = useUIStore(s => s.requestToggleTerminal)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [devBuild, setDevBuild] = useState(false)
  const [appMemory, setAppMemory] = useState<AppMemoryInfo | null>(null)
  const [memoryTipOpen, setMemoryTipOpen] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [gitHead, setGitHead] = useState<GitHeadInfo | null>(null)
  const gitDirtyCount = useGitStatusStore(s => s.dirtyCount)
  const [encodingMenu, setEncodingMenu] = useState<{
    x: number
    y: number
    anchorCenterX: number
  } | null>(null)
  const pushToast = useProjectStore(s => s.pushToast)
  const rowRef = useRef<HTMLDivElement>(null)

  /** Save-encoding + reopen-encoding in one themed menu (not duplicate actions). */
  const encodingMenuItems = () => {
    if (!activeTab) return []
    const current = activeTab.encoding ?? 'utf8'
    return [
      ...FILE_ENCODING_OPTIONS.map(option => ({
        label: t('保存为 {encoding}', { encoding: option.label }),
        checked: option.value === current,
        action: () => setTabEncoding(activeTab.id, option.value),
      })),
      ...REOPEN_FILE_ENCODING_OPTIONS.map((option, index) => ({
        label: t('重新打开：{encoding}', {
          encoding: option.value === 'auto' ? t('自动检测') : option.label,
        }),
        separatorBefore: index === 0,
        action: () => void reopenWithEncoding(activeTab.id, option.value),
      })),
    ]
  }
  const [trustTick, setTrustTick] = useState(0)

  useEffect(() => {
    const sync = () => setTrustTick(n => n + 1)
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
    return () => window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, sync)
  }, [])

  const restricted =
    trustTick >= 0 &&
    !!currentProject &&
    !currentProject.ephemeral &&
    isProjectRestricted(currentProject)

  const activeTab = tabs.find(t => t.id === activeTabId)
  const projectTerminals = terminals.filter(t => t.projectId === currentProject?.id)
  const focusedTerminalId =
    terminalFocusPane === 'secondary' && secondaryTerminalId
      ? secondaryTerminalId
      : activeTerminalId
  const activeTerm = projectTerminals.find(t => t.id === focusedTerminalId)
  const runningTerminals = projectTerminals.filter(t => t.status !== 'exited').length

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!isTauri()) return
      try {
        const [{ getVersion }, isDev] = await Promise.all([
          import('@tauri-apps/api/app'),
          safeInvoke<boolean>('检查构建类型', 'is_dev_build').catch(() => false),
        ])
        const version = await getVersion()
        if (!cancelled) {
          setAppVersion(version)
          setDevBuild(Boolean(isDev))
        }
      } catch {
        // ignore — status bar version is best-effort
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Memory refresh strategy:
  // - background poll every 10s while visible (uses Rust TTL cache)
  // - focus / tab visible → refresh
  // - tip open → force sample + 3s poll so the breakdown stays live
  // - terminal count changes → force sample (shell trees moved)
  useEffect(() => {
    if (!isTauri()) {
      queueMicrotask(() => setAppMemory(null))
      return
    }

    let cancelled = false

    const loadMemory = async (force = false) => {
      if (typeof document !== 'undefined' && document.hidden && !force) return
      try {
        const info = await safeInvoke<AppMemoryInfo>('读取应用内存', 'get_app_memory', {
          force,
        })
        if (!cancelled) setAppMemory(info)
      } catch {
        if (!cancelled) setAppMemory(null)
      }
    }

    // Tip open / terminal churn both want a fresh sample immediately.
    void loadMemory(true)
    const onFocus = () => {
      void loadMemory(true)
    }
    const onVisibility = () => {
      if (!document.hidden) void loadMemory(true)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const intervalMs = memoryTipOpen ? APP_MEMORY_TIP_REFRESH_MS : APP_MEMORY_REFRESH_MS
    const intervalId = window.setInterval(() => {
      void loadMemory(memoryTipOpen)
    }, intervalMs)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(intervalId)
    }
  }, [memoryTipOpen, runningTerminals])

  useEffect(() => {
    const projectPath = currentProject?.path
    // Non-git / ephemeral / browser preview: hide the chip (no placeholder).
    if (!projectPath || !isTauri() || currentProject?.ephemeral) {
      queueMicrotask(() => setGitHead(null))
      return
    }

    let cancelled = false
    const retryTimers: number[] = []

    const applyHead = (info: GitHeadInfo | null) => {
      if (!cancelled) setGitHead(info)
    }

    /** Prefer filesystem HEAD; fall back to SCM cache branch when present. */
    const loadGitHead = async () => {
      const cached = peekSourceControlCache(projectPath)
      try {
        const info = await safeInvoke<GitHeadInfo | null>('读取 Git 分支', 'get_git_head', {
          path: projectPath,
        })
        if (cancelled) return
        if (info) {
          applyHead(info)
          // Keep SCM panel branch in sync when soft refresh left it empty.
          if (cached?.is_repository && !cached.branch) {
            useSourceControlStore.getState().setCache(projectPath, {
              ...cached,
              branch: info.name,
            })
          }
          return
        }
        if (cached?.is_repository && cached.branch) {
          applyHead({ name: cached.branch, detached: false })
          return
        }
        applyHead(null)
      } catch {
        if (cancelled) return
        if (cached?.is_repository && cached.branch) {
          applyHead({ name: cached.branch, detached: false })
        } else {
          applyHead(null)
        }
      }
    }

    // Seed immediately from SCM cache so the chip appears before IPC returns.
    const seed = peekSourceControlCache(projectPath)
    if (seed?.is_repository && seed.branch) {
      applyHead({ name: seed.branch, detached: false })
    } else {
      applyHead(null)
    }

    void loadGitHead()
    // Allowlist sync can lag project switch; retry briefly so a race does not
    // leave the status bar empty until the 15s poll.
    for (const delay of [120, 400, 1000]) {
      retryTimers.push(
        window.setTimeout(() => {
          void loadGitHead()
        }, delay),
      )
    }

    const onFocus = () => {
      void loadGitHead()
    }
    const onVisibility = () => {
      if (!document.hidden) void loadGitHead()
    }
    const onWorktree = (event: Event) => {
      const detail = (event as CustomEvent<{ projectPath?: string }>).detail
      if (detail?.projectPath && detail.projectPath !== projectPath) return
      void loadGitHead()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('qingcode:git-worktree-changed', onWorktree)
    const intervalId = window.setInterval(() => {
      void loadGitHead()
    }, GIT_HEAD_REFRESH_MS)

    // When SCM soft-refresh fills branch later, mirror it into the status bar.
    const unsubScm = useSourceControlStore.subscribe(state => {
      if (cancelled || state.cachedPath !== projectPath) return
      const branch = state.cachedStatus?.is_repository ? state.cachedStatus.branch : null
      if (!branch) return
      setGitHead(prev => prev ?? { name: branch, detached: false })
    })

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('qingcode:git-worktree-changed', onWorktree)
      window.clearInterval(intervalId)
      for (const id of retryTimers) window.clearTimeout(id)
      unsubScm()
    }
  }, [currentProject?.path, currentProject?.ephemeral])

  const showEditorHints = Boolean(activeTab)
  const showEncoding =
    activeTab?.kind === 'diff' ||
    Boolean(activeTab && !activeTab.openError && activeTab.viewMode !== 'view')
  const showMetaGroup = showEncoding || Boolean(appVersion) || Boolean(appMemory)

  return (
    <StatusBarRowContext.Provider value={rowRef}>
    <div
      ref={rowRef}
      {...{ [STATUS_BAR_ROW_ATTR]: '' }}
      className="ui-font-scaled h-[var(--status-bar-height)] flex-shrink-0 bg-bg-deep text-fg text-xs flex items-center gap-1 overflow-hidden px-3 select-none border-t border-border"
    >
      {/* Left: folder · project · git — adjacent; project truncates, branch keeps full width. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <Folder size={13} className="flex-shrink-0 text-brand" />
        <span className="min-w-0 max-w-[28%] truncate">
          {currentProject ? currentProject.name : t('未选择项目')}
        </span>
        {gitHead && (
          <>
            <StatusDivider />
            <StatusTip
              label={
                gitHead.detached
                  ? t('分离的 HEAD（未在分支上）')
                  : gitDirtyCount > 0
                    ? t('当前 Git 分支 · {count} 个更改', { count: gitDirtyCount })
                    : t('当前 Git 分支')
              }
            >
              <button
                type="button"
                className={`inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap ${STATUS_ACTION}`}
                onClick={() => setView('sourceControl')}
              >
                <GitBranch size={13} className="flex-shrink-0" />
                <span>
                  {gitHead.detached ? t('分离 HEAD · {sha}', { sha: gitHead.name }) : gitHead.name}
                </span>
                {gitDirtyCount > 0 && (
                  <span className="flex-shrink-0 text-warn">*{gitDirtyCount}</span>
                )}
              </button>
            </StatusTip>
          </>
        )}
        {restricted && (
          <StatusTip label={t('受限模式：只能浏览，无法编辑或运行')}>
            <span className="flex flex-shrink-0 items-center gap-1 text-warn">
              <ShieldAlert size={13} />
              {t('受限')}
            </span>
          </StatusTip>
        )}
      </div>

      {/* Right: hints | session actions | meta */}
      <div className="flex flex-shrink-0 items-center">
        {showEditorHints && (
          <>
            <div className={`flex items-center gap-2.5 ${STATUS_SECONDARY}`}>
              {cursor && (
                <span className="hidden sm:inline">
                  {t('行 {line}, 列 {col}', { line: cursor.line, col: cursor.col })}
                </span>
              )}
              <StatusTip
                label={t('Ctrl + Shift + C：复制完整文件路径；Alt + C：复制 @项目/相对路径#L行号 引用')}
              >
                <span className="hidden lg:inline">
                  {t('Ctrl+Shift+C 路径 · Alt+C 文件引用')}
                </span>
              </StatusTip>
            </div>
            <StatusDivider />
          </>
        )}

        <StatusTip label={t('切换终端面板')}>
          <button
            type="button"
            aria-label={t('切换终端面板')}
            className={`flex max-w-[180px] items-center gap-1.5 px-1.5 py-px ${STATUS_ACTION}`}
            onClick={requestToggleTerminal}
          >
            <TerminalIcon size={13} className="flex-shrink-0" />
            <span className="truncate">
              {t('{running}/{total} 运行中', { running: runningTerminals, total: projectTerminals.length })}
              {activeTerm ? (
                <span className={STATUS_SECONDARY}>{` · ${formatTerminalName(activeTerm.name)}`}</span>
              ) : null}
            </span>
          </button>
        </StatusTip>

        {showMetaGroup && (
          <>
            <StatusDivider />
            <div className={`text-ui-sm flex items-center font-mono ${STATUS_SECONDARY}`}>
              {activeTab?.kind === 'diff' ? (
                <span>{t('差异对比')}</span>
              ) : activeTab && !activeTab.openError && activeTab.viewMode !== 'view' ? (
                <StatusTip label={t('转换编码（下次保存）· 或按编码重新打开')}>
                  <button
                    type="button"
                    aria-label={t('文件编码')}
                    aria-haspopup="menu"
                    aria-expanded={encodingMenu != null}
                    className={`max-w-[140px] truncate ${STATUS_ACTION}`}
                    onClick={event => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      const menuWidth = 260
                      const anchorCenterX = rect.left + rect.width / 2
                      const rowTop = readStatusBarRowTop(event.currentTarget) ?? rect.top
                      setEncodingMenu({
                        x: anchorCenterX - menuWidth / 2,
                        y: rowTop,
                        anchorCenterX,
                      })
                    }}
                  >
                    {formatFileEncoding(activeTab.encoding)}
                  </button>
                </StatusTip>
              ) : null}
              {showEncoding && (appMemory || appVersion) ? <StatusDivider /> : null}
              {appMemory && (
                <StatusTip
                  label={t(
                    '主进程 {main}\nWebView2 {webview} · 关联终端 {terminal}\n悬停时约每 {tipSec} 秒刷新 · 平时约每 {idleSec} 秒',
                    {
                      main: formatAppMemoryMb(appMemory.mainBytes),
                      webview: formatAppMemoryMb(appMemory.webviewBytes),
                      terminal: formatAppMemoryMb(appMemory.terminalBytes),
                      tipSec: APP_MEMORY_TIP_REFRESH_MS / 1000,
                      idleSec: APP_MEMORY_REFRESH_MS / 1000,
                    },
                  )}
                  onShow={() => setMemoryTipOpen(true)}
                  onHide={() => setMemoryTipOpen(false)}
                >
                  <span className="rounded px-1 -mx-1 tabular-nums">
                    {t('内存 {size}', { size: formatAppMemoryMb(appMemory.totalBytes) })}
                  </span>
                </StatusTip>
              )}
              {appMemory && appVersion ? <StatusDivider /> : null}
              {appVersion && (
                <StatusTip
                  label={
                    updateBusy
                      ? t('正在检查…')
                      : `${
                          devBuild
                            ? t('开发构建：项目数据在仓库 .dev/；主题字体等保存在开发服务器源下')
                            : t('正式构建：项目数据在 %APPDATA%\\com.qingcode.app\\；主题字体等与开发版不共用')
                        }\n${t('点击检查更新')}`
                  }
                >
                  <button
                    type="button"
                    disabled={updateBusy || !isTauri()}
                    className={`${STATUS_ACTION} disabled:opacity-40`}
                    onClick={() => {
                      if (!isTauri() || updateBusy) return
                      setUpdateBusy(true)
                      void checkForAppUpdate({
                        currentVersion: appVersion,
                        ignoreSkip: true,
                        prompt: true,
                      })
                        .then(info => {
                          if (!info) pushToast('success', t('当前已是最新版本'))
                        })
                        .catch(error =>
                          pushToast('error', t('检查更新失败: {error}', { error: String(error) })),
                        )
                        .finally(() => setUpdateBusy(false))
                    }}
                  >
                    v{appVersion}
                    {devBuild ? ' · dev' : ''}
                  </button>
                </StatusTip>
              )}
            </div>
          </>
        )}
      </div>
      {encodingMenu && (
        <ContextMenu
          x={encodingMenu.x}
          y={encodingMenu.y}
          arrowAnchorX={encodingMenu.anchorCenterX}
          items={encodingMenuItems()}
          onClose={() => setEncodingMenu(null)}
          preferAbove
          arrow="bottom-end"
        />
      )}
    </div>
    </StatusBarRowContext.Provider>
  )
}
