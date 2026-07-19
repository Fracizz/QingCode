import { useEffect, useState } from 'react'
import {
  loadTheme,
  saveTheme,
  THEMES,
  getResolvedTheme,
  type AppTheme,
  type ResolvedTheme,
} from '../lib/themeSettings'
import { useI18n } from '../lib/i18n'
import SettingSelect from './SettingSelect'

export default function ThemeSettings() {
  const { t } = useI18n()
  const [theme, setTheme] = useState<AppTheme>(loadTheme)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => getResolvedTheme(theme))

  useEffect(() => {
    setResolved(getResolvedTheme(theme))
  }, [theme])

  const update = (value: AppTheme) => {
    setTheme(value)
    saveTheme(value)
  }

  return (
    <div className="flex flex-col gap-2">
      <SettingSelect
        value={theme}
        onChange={next => update(next as AppTheme)}
        aria-label={t('颜色主题')}
        options={THEMES.map(option => ({
          value: option.value,
          label: t(option.label),
        }))}
      />

      {theme === 'auto' && (
        <p className="text-[12px] text-fg-muted">
          {t('当前解析为：')}<span className="text-fg">{t(resolved === 'dark' ? '深色' : '浅色')}</span>
          {t('（操作系统切换明暗时自动跟随）')}
        </p>
      )}
    </div>
  )
}
