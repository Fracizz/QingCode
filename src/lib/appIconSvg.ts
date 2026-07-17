import appIconSvg from '../assets/app-icon.svg?raw'
import { getResolvedTheme, loadTheme, type ResolvedTheme } from './themeSettings'

const BRACKET_DARK = '#F3F6F8'
const BRACKET_LIGHT = '#2A3539'

function iconSvgForTheme(theme: ResolvedTheme): string {
  if (theme === 'light') {
    return appIconSvg.replace(new RegExp(`fill="${BRACKET_DARK}"`, 'g'), `fill="${BRACKET_LIGHT}"`)
  }
  return appIconSvg
}

/** Render `src/assets/app-icon.svg` at a given pixel size (UI source of truth). */
export function renderAppIconSvg(
  size: number,
  className?: string,
  theme: ResolvedTheme = getResolvedTheme(loadTheme()),
): string {
  const svg = iconSvgForTheme(theme)
  return svg.replace(/<svg([^>]*)>/, (_match, attrs: string) => {
    const cleaned = attrs.replace(/\s(width|height|class)="[^"]*"/g, '').trim()
    const classAttr = className ? ` class="${className}"` : ''
    const extra = cleaned ? ` ${cleaned}` : ''
    return `<svg width="${size}" height="${size}"${classAttr}${extra}>`
  })
}

/** Inject startup splash logo from the same SVG file. */
export function paintStartupSplashLogo(size = 80, theme: ResolvedTheme = getResolvedTheme(loadTheme())) {
  const slot = document.querySelector<HTMLElement>('.startup-logo')
  if (!slot) return
  slot.innerHTML = renderAppIconSvg(size, undefined, theme)
}
