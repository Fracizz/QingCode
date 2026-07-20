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
  const activeTerm = projectTerminals.find(t => t.id === activeTerminalId)
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
      setAppMemory(null)
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
    if (!projectPath || !isTauri()) {
      setGitHead(null)
      return
    }

    let cancelled = false

    const loadGitHead = async () => {
      try {
        const info = await safeInvoke<GitHeadInfo | null>('读取 Git 分支', 'get_git_head', {
          path: projectPath,
        })
        if (!cancelled) setGitHead(info ?? null)
      } catch {
        if (!cancelled) setGitHead(null)
      }
    }

    void loadGitHead()
    const onFocus = () => {
      void loadGitHead()
    }
    window.addEventListener('focus', onFocus)
    const intervalId = window.setInterval(() => {
      void loadGitHead()
    }, GIT_HEAD_REFRESH_MS)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      window.clearInterval(intervalId)
    }
  }, [currentProject?.path])

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
      className="ui-font-scaled h-[var(--status-bar-height)] flex-shrink-0 bg-accent-soft text-fg text-xs flex items-center gap-1 overflow-hidden px-3 select-none border-t border-border"
    >
      {/* Workspace context: project · git */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <span className="flex min-w-0 max-w-[28%] items-center gap-1.5">
          <Folder size={13} className="flex-shrink-0 text-fg-muted" />
          <span className="truncate">{currentProject ? currentProject.name : t('未选择项目')}</span>
        </span>
        {restricted && (
          <StatusTip label={t('受限模式：只能浏览，无法编辑或运行')}>
            <span className="flex flex-shrink-0 items-center gap-1 text-warn">
              <ShieldAlert size={13} />
              {t('受限')}
            </span>
          </StatusTip>
        )}
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
                className="flex min-w-0 max-w-[28%] items-center gap-1.5 rounded px-1 -mx-1 text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
                onClick={() => setView('sourceControl')}
              >
                <GitBranch size={13} className="flex-shrink-0" />
                <span className="truncate text-fg">
                  {gitHead.detached ? t('分离 HEAD · {sha}', { sha: gitHead.name }) : gitHead.name}
                </span>
                {gitDirtyCount > 0 && (
                  <span className="flex-shrink-0 text-warn">*{gitDirtyCount}</span>
                )}
              </button>
            </StatusTip>
          </>
        )}
      </div>

      {/* Right: hints | session actions | meta */}
      <div className="flex flex-shrink-0 items-center">
        {showEditorHints && (
          <>
            <div className="flex items-center gap-2.5 text-fg-muted">
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
            className="flex max-w-[180px] items-center gap-1.5 rounded px-1.5 py-px hover:bg-bg-hover transition-colors"
            onClick={requestToggleTerminal}
          >
            <TerminalIcon size={13} className="flex-shrink-0 text-fg-muted" />
            <span className="truncate">
              {t('{running}/{total} 运行中', { running: runningTerminals, total: projectTerminals.length })}
              {activeTerm ? (
                <span className="text-fg-muted">{` · ${formatTerminalName(activeTerm.name)}`}</span>
              ) : null}
            </span>
          </button>
        </StatusTip>

        {showMetaGroup && (
          <>
            <StatusDivider />
            <div className="flex items-center font-mono text-[11px] text-fg-muted">
              {activeTab?.kind === 'diff' ? (
                <span>{t('差异对比')}</span>
              ) : activeTab && !activeTab.openError && activeTab.viewMode !== 'view' ? (
                <StatusTip label={t('转换编码（下次保存）· 或按编码重新打开')}>
                  <button
                    type="button"
                    aria-label={t('文件编码')}
                    aria-haspopup="menu"
                    aria-expanded={encodingMenu != null}
                    className="max-w-[140px] truncate rounded px-1 -mx-1 hover:bg-bg-hover hover:text-fg transition-colors"
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
                    className="rounded px-1 -mx-1 hover:bg-bg-hover hover:text-fg disabled:opacity-40 transition-colors"
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
