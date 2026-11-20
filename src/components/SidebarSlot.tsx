import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { animatePanelWidth, canAnimateLayout } from '../lib/layoutMotion'
import { beginPanelLayoutResize } from '../lib/panelResize'

interface Props {
  width: number
  /** 侧栏正在收起：收拢动画播完后调用 onExited，由父组件卸载。 */
  leaving: boolean
  onExited: () => void
  /** 挂载时是否播放展开（应用首屏、恢复布局时不播）。 */
  animateOpen: boolean
  /** 侧栏宽度会挤压侧边终端时，动画期间冻结终端画面，结束后再适配尺寸（同拖动分隔条）。 */
  freezeTerminals: boolean
  children: ReactNode
}

/** 开合时从当前宽度继续过渡，内容保持原宽并随侧栏边缘裁切。 */
export default function SidebarSlot({
  width, leaving, onExited, animateOpen, freezeTerminals, children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const motion = useRef<{ animation: Animation; finish: () => void } | null>(null)
  const releaseResize = useRef<(() => void) | null>(null)
  const previousLayout = useRef<{ width: number; leaving: boolean; freezeTerminals: boolean } | null>(null)
  const onExitedRef = useRef(onExited)

  useLayoutEffect(() => {
    onExitedRef.current = onExited
  }, [onExited])

  useLayoutEffect(() => {
    const slot = ref.current
    const previous = previousLayout.current
    previousLayout.current = { width, leaving, freezeTerminals }
    if (!slot) return

    const toggled = previous ? previous.leaving !== leaving : animateOpen || leaving
    if (!toggled) {
      if (previous && (previous.width !== width || previous.freezeTerminals !== freezeTerminals)) motion.current?.finish()
      return
    }

    const fromWidth = motion.current ? slot.getBoundingClientRect().width :
      previous && !previous.leaving ? previous.width : 0
    motion.current?.animation.cancel()
    motion.current = null

    const toWidth = leaving ? 0 : width
    const finish = () => {
      motion.current?.animation.cancel()
      motion.current = null
      delete slot.dataset.sidebarMotion
      const release = releaseResize.current
      releaseResize.current = null
      if (leaving) {
        slot.style.width = '0px'
      } else {
        slot.style.removeProperty('width')
        slot.style.removeProperty('overflow')
        slot.style.removeProperty('justify-content')
      }
      release?.()
      if (leaving) onExitedRef.current()
    }
    if (!canAnimateLayout(slot) || !width || Math.abs(toWidth - fromWidth) < 1) {
      finish()
      return
    }

    slot.dataset.sidebarMotion = ''
    slot.style.overflow = 'hidden'
    slot.style.justifyContent = 'flex-end'
    slot.style.width = `${fromWidth}px`
    if (freezeTerminals && !releaseResize.current) {
      releaseResize.current = beginPanelLayoutResize(() => motion.current?.finish())
      if (!releaseResize.current) {
        finish()
        return
      }
    }

    const animation = animatePanelWidth(slot, fromWidth, toWidth, width)
    slot.style.removeProperty('width')
    motion.current = { animation, finish }
    animation.onfinish = () => {
      if (motion.current?.animation === animation) finish()
    }
  }, [leaving, animateOpen, width, freezeTerminals])

  useLayoutEffect(() => {
    const slot = ref.current
    return () => {
      previousLayout.current = null
      motion.current?.animation.cancel()
      motion.current = null
      slot?.style.removeProperty('width')
      slot?.style.removeProperty('overflow')
      slot?.style.removeProperty('justify-content')
      if (slot) delete slot.dataset.sidebarMotion
      releaseResize.current?.()
      releaseResize.current = null
    }
  }, [])

  return (
    <div ref={ref} className="workspace-grid-sidebar flex" inert={leaving || undefined}>
      {children}
    </div>
  )
}
