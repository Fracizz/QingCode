import { useI18n } from '../lib/i18n'

export default function LanguageSettings() {
  const { language, setLanguage, localeOptions, t } = useI18n()

  return (
    <label className="block">
      <select
        value={language}
        onChange={event => setLanguage(event.target.value)}
        aria-label={t('语言')}
        className="w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent"
      >
        {localeOptions.map(option => (
          <option key={option.locale} value={option.locale}>
            {option.builtin ? t(option.label) : option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
