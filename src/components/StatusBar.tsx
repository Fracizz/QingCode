import { useEffect, useState } from 'react'
import { GitBranch, FolderTree, FileText, Terminal as TerminalIcon } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { formatTerminalName } from '../utils/terminalName'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { isTauri, safeInvoke } from '../lib/tauri'

export default function StatusBar() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [devBuild, setDevBuild] = useState(false)

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

  return (
    <div className="ui-font-scaled h-[var(--status-bar-height)] flex-shrink-0 bg-accent-soft text-fg text-xs flex items-center px-3 gap-4 select-none border-t border-border">
      <span className="flex items-center gap-1.5">
        <FolderTree size={13} />
        {currentProject ? currentProject.name : t('未选择项目')}
      </span>
      {activeTab && (
        <span className="flex items-center gap-1.5 opacity-90">
          <FileText size={13} />
          {activeTab.name}
          {activeTab.dirty && <span className="text-warn">●</span>}
        </span>
      )}
      <span className="flex items-center gap-1.5 opacity-90">
        <GitBranch size={13} />main
      </span>
      <div className="flex-1" />
      {activeTab && (
        <Tooltip
          label={t('Ctrl + Shift + C：复制完整文件路径；Alt + C：复制 @项目/相对路径#L行号 引用')}
          side="top"
        >
          <span className="opacity-75">
            {t('Ctrl+Shift+C 路径 · Alt+C 文件引用')}
          </span>
        </Tooltip>
      )}
      <span className="flex items-center gap-1.5 opacity-90">
        <TerminalIcon size={13} />
        {t('{running}/{total} 运行中', { running: runningTerminals, total: projectTerminals.length })}
        {activeTerm ? ` · ${formatTerminalName(activeTerm.name)}` : ''}
      </span>
      <span className="opacity-90">{t('{count} 个已打开', { count: tabs.length })}</span>
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
  )
}
