import { useState } from 'react'
import { loadTheme, saveTheme, THEMES, type AppTheme } from '../lib/themeSettings'

export default function ThemeSettings() {
  const [theme, setTheme] = useState(loadTheme)

  const update = (value: AppTheme) => {
    setTheme(value)
    saveTheme(value)
  }

  return (
    <section className="flex flex-col gap-4 px-4 py-5 text-[13px]">
      <div>
        <h2 className="text-sm font-medium text-fg">外观</h2>
        <p className="mt-1 leading-relaxed text-fg-muted">选择界面整体主题色调。</p>
      </div>

      <label className="block">
        <span className="block font-medium text-fg">主题</span>
        <select
          value={theme}
          onChange={event => update(event.target.value as AppTheme)}
          className="mt-2 w-full rounded border border-border-strong bg-bg-elevated px-2.5 py-2 text-fg outline-none focus:border-accent"
        >
          {THEMES.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}
