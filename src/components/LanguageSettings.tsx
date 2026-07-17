import { localeOptions, useI18n, type AppLanguage } from '../lib/i18n'

export default function LanguageSettings() {
  const { language, setLanguage, t } = useI18n()

  return (
    <label className="block">
      <select
        value={language}
        onChange={event => setLanguage(event.target.value as AppLanguage)}
        aria-label={t('语言')}
        className="w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent"
      >
        {localeOptions.map(option => (
          <option key={option.locale} value={option.locale}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </label>
  )
}
