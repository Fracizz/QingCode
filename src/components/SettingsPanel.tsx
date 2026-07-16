import { Settings } from 'lucide-react'
import FontSettings from './FontSettings'
import ThemeSettings from './ThemeSettings'
import TerminalSettings from './TerminalSettings'
import SettingsSection from './SettingsSection'

export default function SettingsPanel() {
  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="flex-shrink-0 px-4 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
        <Settings size={13} /> 设置
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <SettingsSection title="外观" description="选择界面整体主题色调。">
          <ThemeSettings />
        </SettingsSection>
        <SettingsSection
          title="字体"
          description="界面字体与代码、终端字体分开设置；字号可独立调整。"
        >
          <FontSettings />
        </SettingsSection>
        <SettingsSection
          title="终端"
          description="配置默认启动方式与终端配置文件。"
        >
          <TerminalSettings />
        </SettingsSection>
      </div>
    </div>
  )
}
