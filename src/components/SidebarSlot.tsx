import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { canAnimateLayout, cssDuration, EASE_SOFT, guardAnimation } from '../lib/layoutMotion'
import { beginPanelResize, settlePanelResize } from '../lib/panelResize'

interface Props {
  width: number
  /** 工作台的普通侧栏和整页各有宽度，切换类别时才播宽度过渡。 */
  widthMode?: 'sidebar' | 'page'
  /** 侧栏正在收起：收拢动画播完后调用 onExited，由父组件卸载。 */
  leaving: boolean
  onExited: () => void
  /** 挂载时是否播放展开（应用首屏、恢复布局时不播）。 */
  animateOpen: boolean
  /** 侧栏宽度会挤压侧边终端时，动画期间冻结终端画面，结束后再适配尺寸（同拖动分隔条）。 */
  freezeTerminals: boolean
  children: ReactNode
}

/**
 * 开合时内容贴右裁切；工作台的窄栏与整页互换时从同一个左缘裁切。
 * 连点从当前宽度接着播，拖动和窗口缩放直接使用新宽度。
 */
export default function SidebarSlot({
  width, widthMode, leaving, onExited, animateOpen, freezeTerminals, children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const slotAnimation = useRef<Animation | null>(null)
  const contentAnimation = useRef<Animation | null>(null)
  const frozen = useRef(false)
  const previousLayout = useRef<{ width: number; widthMode: Props['widthMode']; leaving: boolean } | null>(null)
  const onExitedRef = useRef(onExited)
  const freezeRef = useRef(freezeTerminals)

  useLayoutEffect(() => {
    onExitedRef.current = onExited
    freezeRef.current = freezeTerminals
  })

  useLayoutEffect(() => {
    const slot = ref.current
    const previous = previousLayout.current
    previousLayout.current = { width, widthMode, leaving }
    if (!slot) return

    const settle = (keepClip = false) => {
      if (!keepClip) {
        slot.style.removeProperty('overflow')
        slot.style.removeProperty('justify-content')
      }
      if (frozen.current) {
        frozen.current = false
        settlePanelResize('vertical')
      }
    }

    const widthModeChanged = widthMode && previous?.widthMode && previous.widthMode !== widthMode
    const toggled = previous ? previous.leaving !== leaving : animateOpen || leaving
    const cancel = () => {
      slotAnimation.current?.cancel()
      contentAnimation.current?.cancel()
      slotAnimation.current = null
      contentAnimation.current = null
    }
    if (!toggled && !widthModeChanged) {
      if (!leaving && previous?.width !== width && slotAnimation.current) {
        cancel()
        settle()
      }
      return
    }

    const content = slot.firstElementChild instanceof HTMLElement ? slot.firstElementChild : null
    const fromWidth = slotAnimation.current ? slot.getBoundingClientRect().width :
      previous && !previous.leaving ? previous.width : 0
    const computedOpacity = content ? parseFloat(getComputedStyle(content).opacity) : 1
    const fromOpacity = Number.isFinite(computedOpacity) ? computedOpacity : 1
    cancel()

    const toWidth = leaving ? 0 : width
    const distance = Math.abs(toWidth - fromWidth)
    if (!canAnimateLayout(slot) || !width || distance < 1) {
      settle()
      if (leaving) onExitedRef.current()
      return
    }

    const span = widthModeChanged && !toggled ? Math.abs(width - previous.width) : width
    const base = toWidth < fromWidth ? cssDuration('--motion-view-exit', 200) : cssDuration('--motion-view', 260)
    const duration = Math.max(60, base * Math.min(1, distance / Math.max(1, span)))
    const timing: KeyframeAnimationOptions = { duration, easing: EASE_SOFT, fill: 'both' }

    slot.style.overflow = 'hidden'
    slot.style.justifyContent = toggled ? 'flex-end' : 'flex-start'
    if (freezeRef.current && !frozen.current) {
      frozen.current = true
      // DOM 已提交新视图，先恢复过渡起点的几何再截取终端。
      slot.style.width = `${fromWidth}px`
      beginPanelResize('vertical', { cursor: false })
    }

    const animation = slot.animate([{ width: `${fromWidth}px` }, { width: `${toWidth}px` }], timing)
    slot.style.removeProperty('width')
    slotAnimation.current = animation
    guardAnimation(animation, duration)
    if (content && (leaving || fromOpacity < 1)) {
      contentAnimation.current = content.animate(
        [{ opacity: fromOpacity }, { opacity: leaving ? 0 : 1 }],
        timing,
      )
    }
    animation.onfinish = () => {
      if (slotAnimation.current !== animation) return
      if (leaving) {
        // 保持收拢后的 0 宽与裁切直到卸载，避免回弹或内容溢出一帧。
        settle(true)
        onExitedRef.current()
        return
      }
      cancel()
      settle()
    }
  }, [leaving, animateOpen, width, widthMode])

  useLayoutEffect(() => {
    const slot = ref.current
    return () => {
      previousLayout.current = null
      slotAnimation.current?.cancel()
      contentAnimation.current?.cancel()
      slotAnimation.current = null
      contentAnimation.current = null
      slot?.style.removeProperty('overflow')
      slot?.style.removeProperty('justify-content')
      if (frozen.current) {
        frozen.current = false
        settlePanelResize('vertical')
      }
    }
  }, [])

  return (
    <div ref={ref} className="workspace-grid-sidebar flex" inert={leaving || undefined}>
      {children}
    </div>
  )
}
