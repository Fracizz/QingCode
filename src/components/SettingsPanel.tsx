import { Settings } from 'lucide-react'
import FontSettings from './FontSettings'
import ThemeSettings from './ThemeSettings'
import TerminalSettings from './TerminalSettings'

export default function SettingsPanel() {
  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="flex-shrink-0 px-4 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
        <Settings size={13} /> 设置
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <FontSettings />
        <div className="border-t border-border-strong" />
        <ThemeSettings />
        <div className="border-t border-border-strong" />
        <TerminalSettings />
      </div>
    </div>
  )
}
