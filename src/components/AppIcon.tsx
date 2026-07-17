import { useEffect, useState } from 'react'
import { renderAppIconSvg } from '../lib/appIconSvg'
import {
  getResolvedTheme,
  loadTheme,
  THEME_SETTINGS_EVENT,
  type ResolvedTheme,
} from '../lib/themeSettings'

interface Props {
  size?: number
  className?: string
}

/** Inline app mark — sourced from src/assets/app-icon.svg */
export default function AppIcon({ size = 16, className }: Props) {
  const [resolved, setResolved] = useState<ResolvedTheme>(() => getResolvedTheme(loadTheme()))

  useEffect(() => {
    const sync = () => setResolved(getResolvedTheme(loadTheme()))
    window.addEventListener(THEME_SETTINGS_EVENT, sync)
    return () => window.removeEventListener(THEME_SETTINGS_EVENT, sync)
  }, [])

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0"
      dangerouslySetInnerHTML={{ __html: renderAppIconSvg(size, className, resolved) }}
    />
  )
}
