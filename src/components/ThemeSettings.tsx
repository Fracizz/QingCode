import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import {
  loadTheme,
  saveTheme,
  THEMES,
  getResolvedTheme,
  type AppTheme,
  type ResolvedTheme,
} from '../lib/themeSettings'
import { useI18n } from '../lib/i18n'

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
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2">
        {THEMES.map(option => {
          const active = option.value === theme
          return (
            <button
              key={option.value}
              onClick={() => update(option.value)}
              className={`relative flex flex-col gap-2 rounded-md border p-2 text-left transition-colors
                ${active
                  ? 'border-accent ring-1 ring-accent/40'
                  : 'border-border-strong hover:border-accent/60'}`}
            >
              <ThemePreview value={option.value} />
              <span className="flex items-center justify-between">
                <span className="font-medium text-fg">{t(option.label)}</span>
                {active && <Check size={13} className="text-accent" />}
              </span>
              <span className="text-[11px] text-fg-dim leading-snug">{t(option.hint)}</span>
            </button>
          )
        })}
      </div>

      {theme === 'auto' && (
        <p className="text-[12px] text-fg-muted">
          {t('当前解析为：')}<span className="text-fg">{t(resolved === 'dark' ? '深色' : '浅色')}</span>
          {t('（操作系统切换明暗时自动跟随）')}
        </p>
      )}
    </div>
  )
}

function ThemePreview({ value }: { value: AppTheme }) {
  const resolved = getResolvedTheme(value)
  const bg = resolved === 'dark' ? '#1e1e1e' : '#f0f0f0'
  const sidebar = resolved === 'dark' ? '#252526' : '#e2e2e2'
  const fg = resolved === 'dark' ? '#d4d4d4' : '#1f1f1f'
  const accent = resolved === 'dark' ? '#4d9eff' : '#005fb8'
  return (
    <div
      className="h-12 w-full overflow-hidden rounded border border-border"
      style={{ background: bg }}
    >
      <div className="flex h-full">
        <div className="w-1/3 h-full" style={{ background: sidebar }} />
        <div className="flex-1 flex flex-col gap-1 p-1.5">
          <div className="h-1.5 w-3/4 rounded-sm" style={{ background: fg, opacity: 0.85 }} />
          <div className="h-1.5 w-1/2 rounded-sm" style={{ background: accent }} />
          <div className="h-1.5 w-2/3 rounded-sm" style={{ background: fg, opacity: 0.35 }} />
        </div>
      </div>
    </div>
  )
}
