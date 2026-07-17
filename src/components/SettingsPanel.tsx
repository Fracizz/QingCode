import { useState } from 'react'
import { CircleHelp, Settings } from 'lucide-react'
import FontSettings from './FontSettings'
import ThemeSettings from './ThemeSettings'
import TerminalSettings from './TerminalSettings'
import SettingsSection from './SettingsSection'
import LanguageSettings from './LanguageSettings'
import ProjectCustomSettings from './ProjectCustomSettings'
import HelpDialog from './HelpDialog'
import ShortcutSettings from './ShortcutSettings'
import { useI18n } from '../lib/i18n'

export default function SettingsPanel() {
  const { t } = useI18n()
  const [helpOpen, setHelpOpen] = useState(false)

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="flex-shrink-0 px-4 h-9 flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
        <span className="flex items-center gap-2"><Settings size={13} /> {t('设置')}</span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <CircleHelp size={14} /> {t('帮助文档')}
        </button>
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
        <SettingsSection title={t('快捷键')} description={t('设置常用操作的按键组合。')}>
          <ShortcutSettings />
        </SettingsSection>
        <SettingsSection title={t('语言')} description={t('选择界面显示语言。')}>
          <LanguageSettings />
        </SettingsSection>
        <SettingsSection
          title={t('项目自定义设置')}
          description={t('将项目专属配置保存在 .qingcode/settings.json，供后续功能扩展使用。')}
        >
          <ProjectCustomSettings />
        </SettingsSection>
      </div>
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  )
}
