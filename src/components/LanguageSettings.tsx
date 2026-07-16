import { useI18n, type AppLanguage } from '../lib/i18n'

const options: { value: AppLanguage; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

export default function LanguageSettings() {
  const { language, setLanguage, t } = useI18n()

  return (
    <label className="block">
      <span className="block font-medium text-fg">{t('语言')}</span>
      <span className="mt-1 block text-xs text-fg-muted">{t('选择界面显示语言。')}</span>
      <select
        value={language}
        onChange={event => setLanguage(event.target.value as AppLanguage)}
        className="mt-2 w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </label>
  )
}
