import { useLayoutEffect, useRef } from 'react'
import type { PanelLayoutTemplate } from '../lib/panelLayoutTemplate'
import { animatePanelWidth, canAnimateLayout } from '../lib/layoutMotion'
import { beginPanelLayoutResize } from '../lib/panelResize'

function measureDestination(column: HTMLElement, grid: HTMLElement, sidebarWidth: number) {
  const sidebar = grid.querySelector<HTMLElement>('[data-sidebar-motion]')
  if (!sidebar) return column.getBoundingClientRect().width

  // 两个分隔线同时变化时，按侧栏最终宽度计算编辑器的目标尺寸。
  const width = sidebar.style.getPropertyValue('width')
  const priority = sidebar.style.getPropertyPriority('width')
  sidebar.style.setProperty('width', `${sidebarWidth}px`, 'important')
  const destination = column.getBoundingClientRect().width
  sidebar.style.setProperty('width', width, priority)
  return destination
}

/** 编辑器开合只移动分隔线，按完整宽度显示并裁切正文。 */
export function useEditorColumnMotion(
  layout: PanelLayoutTemplate,
  visible: boolean,
  enabled: boolean,
  sidebarWidth: number,
) {
  const columnRef = useRef<HTMLDivElement>(null)
  const expandedWidth = useRef(0)
  const previous = useRef({ layout, visible, enabled, sidebarWidth })
  const motion = useRef<{ animation: Animation; finish: () => void } | null>(null)
  const releaseResize = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const column = columnRef.current
    const grid = column?.parentElement
    const before = previous.current
    previous.current = { layout, visible, enabled, sidebarWidth }
    if (!column || !grid) return

    const rememberWidth = () => {
      if (visible) expandedWidth.current = column.getBoundingClientRect().width
    }
    if (layout !== before.layout || !enabled || !before.enabled || !canAnimateLayout(column)) {
      motion.current?.finish()
      rememberWidth()
      return
    }
    const running = motion.current
    if (visible === before.visible && !(running && sidebarWidth !== before.sidebarWidth)) return

    const from = running ? column.getBoundingClientRect().width : before.visible ? expandedWidth.current : 0
    const clearWidth = () => {
      motion.current?.animation.cancel()
      motion.current = null
      delete grid.dataset.editorSplitMotion
      column.style.removeProperty('width')
      column.style.removeProperty('--editor-content-width')
    }
    clearWidth()
    const to = visible ? measureDestination(column, grid, sidebarWidth) : 0
    const finish = () => {
      clearWidth()
      rememberWidth()
      const release = releaseResize.current
      releaseResize.current = null
      release?.()
    }
    if (Math.abs(to - from) < 1) {
      finish()
      return
    }

    grid.dataset.editorSplitMotion = ''
    const fullWidth = visible ? to : Math.max(expandedWidth.current, from)
    column.style.setProperty('--editor-content-width', `${fullWidth}px`)
    column.style.width = `${from}px`
    releaseResize.current ??= beginPanelLayoutResize(() => motion.current?.finish())
    if (!releaseResize.current) {
      finish()
      return
    }

    const animation = animatePanelWidth(column, from, to, Math.max(fullWidth, from))
    column.style.removeProperty('width')
    motion.current = { animation, finish }
    animation.onfinish = () => {
      if (motion.current?.animation === animation) finish()
    }
  }, [layout, visible, enabled, sidebarWidth])

  useLayoutEffect(() => {
    const column = columnRef.current
    if (!column) return
    const observer = new ResizeObserver(() => {
      if (previous.current.visible && !motion.current) expandedWidth.current = column.getBoundingClientRect().width
    })
    observer.observe(column)
    const onResize = () => motion.current?.finish()
    window.addEventListener('resize', onResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      onResize()
    }
  }, [])

  return columnRef
}
