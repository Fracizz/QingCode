import { useEffect, useState } from 'react'
import { GitBranch, FolderTree, FileText, Terminal as TerminalIcon, ShieldAlert } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { formatTerminalName } from '../utils/terminalName'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { isTauri, safeInvoke } from '../lib/tauri'
import {
  isProjectRestricted,
  WORKSPACE_TRUST_CHANGED_EVENT,
} from '../lib/workspaceTrust'
import { useGitStatusStore } from '../store/gitStatusStore'
import { getFileIcon } from '../utils/fileIcons'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import {
  FILE_ENCODING_OPTIONS,
  REOPEN_FILE_ENCODING_OPTIONS,
  formatFileEncoding,
} from '../lib/fileEncoding'
import type { FileEncoding, WritableFileEncoding } from '../lib/editorSettings'

type GitHeadInfo = {
  name: string
  detached: boolean
}

const GIT_HEAD_REFRESH_MS = 15_000

export default function StatusBar() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const setActiveTab = useEditorStore(s => s.setActiveTab)
  const cursor = useEditorStore(s => s.cursor)
  const setTabEncoding = useEditorStore(s => s.setTabEncoding)
  const reopenWithEncoding = useEditorStore(s => s.reopenWithEncoding)
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const setView = useUIStore(s => s.setView)
  const requestToggleTerminal = useUIStore(s => s.requestToggleTerminal)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [devBuild, setDevBuild] = useState(false)
  const [gitHead, setGitHead] = useState<GitHeadInfo | null>(null)
  const gitDirtyCount = useGitStatusStore(s => s.dirtyCount)
  const [tabsMenu, setTabsMenu] = useState<{ x: number; y: number } | null>(null)

  const tabsMenuItems = (): ContextMenuItem[] =>
    tabs.map(tab => {
      const Icon = getFileIcon(tab.name)
      return {
        label: tab.id === activeTabId ? `${tab.name} ●` : tab.name,
        icon: Icon ? <Icon size={14} /> : undefined,
        action: () => setActiveTab(tab.id),
      }
    })
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

  return (
    <div className="ui-font-scaled h-[var(--status-bar-height)] flex-shrink-0 bg-accent-soft text-fg text-xs flex items-center gap-3 overflow-hidden px-3 select-none border-t border-border">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <span className="flex min-w-0 max-w-[28%] items-center gap-1.5">
          <FolderTree size={13} className="flex-shrink-0" />
          <span className="truncate">{currentProject ? currentProject.name : t('未选择项目')}</span>
        </span>
        {restricted && (
          <Tooltip label={t('受限模式：只能浏览，无法编辑或运行')} side="top">
            <span className="flex flex-shrink-0 items-center gap-1 text-warn">
              <ShieldAlert size={13} />
              {t('受限')}
            </span>
          </Tooltip>
        )}
        {activeTab && (
          <span className="flex min-w-0 max-w-[36%] items-center gap-1.5 opacity-90">
            <FileText size={13} className="flex-shrink-0" />
            <span className="truncate">{activeTab.name}</span>
            {activeTab.dirty && <span className="flex-shrink-0 text-warn">●</span>}
          </span>
        )}
        {gitHead && (
          <Tooltip
            label={
              gitHead.detached
                ? t('分离的 HEAD（未在分支上）')
                : gitDirtyCount > 0
                  ? t('当前 Git 分支 · {count} 个更改', { count: gitDirtyCount })
                  : t('当前 Git 分支')
            }
            side="top"
          >
            <button
              type="button"
              className="flex min-w-0 max-w-[28%] items-center gap-1.5 rounded px-1 -mx-1 opacity-90 hover:opacity-100 hover:bg-bg-hover transition-colors"
              onClick={() => setView('sourceControl')}
            >
              <GitBranch size={13} className="flex-shrink-0" />
              <span className="truncate">
                {gitHead.detached ? t('分离 HEAD · {sha}', { sha: gitHead.name }) : gitHead.name}
              </span>
              {gitDirtyCount > 0 && (
                <span className="flex-shrink-0 text-warn">*{gitDirtyCount}</span>
              )}
            </button>
          </Tooltip>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-3">
        {activeTab && cursor && (
          <span className="hidden opacity-75 sm:inline">
            {t('行 {line}, 列 {col}', { line: cursor.line, col: cursor.col })}
          </span>
        )}
        {activeTab && (
          <Tooltip
            label={t('Ctrl + Shift + C：复制完整文件路径；Alt + C：复制 @项目/相对路径#L行号 引用')}
            side="top"
          >
            <span className="hidden opacity-75 lg:inline">
              {t('Ctrl+Shift+C 路径 · Alt+C 文件引用')}
            </span>
          </Tooltip>
        )}
        <Tooltip label={t('切换终端面板')} side="top">
          <button
            type="button"
            className="flex max-w-[180px] items-center gap-1.5 rounded px-1 -mx-1 opacity-90 hover:opacity-100 hover:bg-bg-hover transition-colors"
            onClick={requestToggleTerminal}
          >
            <TerminalIcon size={13} className="flex-shrink-0" />
            <span className="truncate">
              {t('{running}/{total} 运行中', { running: runningTerminals, total: projectTerminals.length })}
              {activeTerm ? ` · ${formatTerminalName(activeTerm.name)}` : ''}
            </span>
          </button>
        </Tooltip>
        {tabs.length > 0 ? (
          <Tooltip label={t('显示所有打开的文件')} side="top">
            <button
              type="button"
              className="flex-shrink-0 rounded px-1 -mx-1 opacity-90 hover:opacity-100 hover:bg-bg-hover transition-colors"
              onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                // Open above the status bar and right-align to the control.
                const menuWidth = 220
                setTabsMenu({
                  x: Math.max(8, rect.right - menuWidth),
                  y: Math.max(8, rect.top - 4),
                })
              }}
            >
              {t('{count} 个已打开', { count: tabs.length })}
            </button>
          </Tooltip>
        ) : (
          <span className="flex-shrink-0 opacity-90">{t('{count} 个已打开', { count: tabs.length })}</span>
        )}
        {activeTab?.kind === 'diff' ? (
          <span className="opacity-75">{t('差异对比')}</span>
        ) : activeTab && !activeTab.openError && activeTab.viewMode !== 'view' ? (
          <>
            <select
              value={activeTab.encoding ?? 'utf8'}
              aria-label={t('文件编码')}
              title={t('转换文件编码，保存后生效')}
              onChange={event => setTabEncoding(activeTab.id, event.target.value as WritableFileEncoding)}
              className="max-w-[116px] cursor-pointer bg-transparent font-mono text-[11px] text-fg-muted outline-none hover:text-fg"
            >
              {!FILE_ENCODING_OPTIONS.some(option => option.value === activeTab.encoding) && activeTab.encoding && (
                <option value={activeTab.encoding}>{formatFileEncoding(activeTab.encoding)}</option>
              )}
              {FILE_ENCODING_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value=""
              aria-label={t('按编码重新打开')}
              title={t('按指定编码重新读取磁盘文件，未保存修改不会被保留')}
              onChange={event => void reopenWithEncoding(activeTab.id, event.target.value as FileEncoding)}
              className="max-w-[92px] cursor-pointer bg-transparent font-mono text-[11px] text-fg-muted outline-none hover:text-fg"
            >
              <option value="" disabled>{t('重新打开…')}</option>
              {REOPEN_FILE_ENCODING_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {appVersion && (
          <Tooltip
            label={
              devBuild
                ? t('开发构建：项目数据在仓库 .dev/；主题字体等保存在开发服务器源下')
                : t('正式构建：项目数据在 %APPDATA%\\com.qingcode.app\\；主题字体等与开发版不共用')
            }
            side="top"
          >
            <span className="opacity-80 font-mono">
              v{appVersion}
              {devBuild ? ' · dev' : ''}
            </span>
          </Tooltip>
        )}
      </div>
      {tabsMenu && (
        <ContextMenu
          x={tabsMenu.x}
          y={tabsMenu.y}
          items={tabsMenuItems()}
          onClose={() => setTabsMenu(null)}
          preferAbove
        />
      )}
    </div>
  )
}
