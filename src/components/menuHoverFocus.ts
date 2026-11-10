import type { MouseEvent } from 'react'

/** 菜单项之间的统一间隔：避免选中/焦点项与悬停项背景连成一片。 */
export const MENU_ITEM_GAP_CLASS = 'flex flex-col gap-[3px]'

/**
 * 挂在菜单容器的 onMouseOver 上：焦点跟随鼠标悬停的可用菜单项，
 * 避免原焦点项的 focus 背景与悬停项同时高亮。
 */
export function focusHoveredMenuItem(event: MouseEvent<HTMLElement>) {
  const target = event.target
  if (!(target instanceof Element)) return
  const item = target.closest<HTMLElement>('[role="menuitem"]')
  if (!item || !event.currentTarget.contains(item)) return
  if (item.matches(':disabled, [aria-disabled="true"]') || item.tabIndex < 0) return
  if (document.activeElement !== item) item.focus({ preventScroll: true })
}
