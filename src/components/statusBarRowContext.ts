import { createContext, useContext, type RefObject } from 'react'

/** `data-*` on {@link StatusBar} root — clearance is measured to this row top. */
export const STATUS_BAR_ROW_ATTR = 'data-status-bar-row'

/** Root row element of {@link StatusBar} (full status-bar band height). */
export const StatusBarRowContext = createContext<RefObject<HTMLElement | null> | null>(null)

/** Viewport Y of the status-bar row top from a trigger inside the bar. */
export function readStatusBarRowTop(from: Element | null | undefined): number | undefined {
  const row = from?.closest(`[${STATUS_BAR_ROW_ATTR}]`)
  if (!(row instanceof HTMLElement)) return undefined
  const top = row.getBoundingClientRect().top
  return Number.isFinite(top) ? top : undefined
}

/** Viewport Y of the status-bar row top, when inside `StatusBar`. */
export function useStatusBarRowTop(): (() => number | undefined) | undefined {
  const ref = useContext(StatusBarRowContext)
  if (!ref) return undefined
  return () => readStatusBarRowTop(ref.current) ?? ref.current?.getBoundingClientRect().top
}
