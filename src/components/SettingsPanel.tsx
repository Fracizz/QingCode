import { Settings } from 'lucide-react'
import FontSettings from './FontSettings'
import ThemeSettings from './ThemeSettings'
import TerminalSettings from './TerminalSettings'
import SettingsSection from './SettingsSection'
import LanguageSettings from './LanguageSettings'
import { useI18n } from '../lib/i18n'

export default function SettingsPanel() {
  const { t } = useI18n()

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="flex-shrink-0 px-4 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
        <Settings size={13} /> {t('设置')}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <SettingsSection title={t('外观')} description={t('选择界面整体主题色调。')}>
          <ThemeSettings />
        </SettingsSection>
        <SettingsSection
          title={t('字体')}
          description={t('界面与代码/终端字体均支持系统默认；代码与终端共用同一等宽字体族，字号可独立调整。')}
        >
          <FontSettings />
        </SettingsSection>
        <SettingsSection
          title={t('终端')}
          description={t('配置默认启动方式与终端配置文件。')}
        >
          <TerminalSettings />
        </SettingsSection>
        <SettingsSection title={t('语言')} description={t('选择界面显示语言。')}>
          <LanguageSettings />
        </SettingsSection>
      </div>
    </div>
  )
}
