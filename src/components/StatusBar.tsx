import { GitBranch, FolderTree, FileText, Terminal as TerminalIcon } from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { formatTerminalName } from '../utils/terminalName'

export default function StatusBar() {
  const currentProject = useProjectStore(s => s.currentProject)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)

  const activeTab = tabs.find(t => t.id === activeTabId)
  const projectTerminals = terminals.filter(t => t.projectId === currentProject?.id)
  const activeTerm = projectTerminals.find(t => t.id === activeTerminalId)
  const runningTerminals = projectTerminals.filter(t => t.status !== 'exited').length

  return (
    <div className="ui-font-scaled h-[var(--status-bar-height)] flex-shrink-0 bg-accent-soft text-fg text-xs flex items-center px-3 gap-4 select-none border-t border-border">
      <span className="flex items-center gap-1.5">
        <FolderTree size={13} />
        {currentProject ? currentProject.name : '未选择项目'}
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
        <span
          className="opacity-75"
          title="Ctrl + Shift + C：复制完整文件路径；Alt + C：复制 @项目/相对路径#L行号 引用"
        >
          Ctrl+Shift+C 路径 · Alt+C 文件引用
        </span>
      )}
      <span className="flex items-center gap-1.5 opacity-90">
        <TerminalIcon size={13} />
        {runningTerminals}/{projectTerminals.length} 运行中
        {activeTerm ? ` · ${formatTerminalName(activeTerm.name)}` : ''}
      </span>
      <span className="opacity-90">{tabs.length} 个已打开</span>
    </div>
  )
}
