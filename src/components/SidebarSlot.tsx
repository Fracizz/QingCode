import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { canAnimateLayout, cssDuration, EASE_SOFT } from '../lib/layoutMotion'
import { beginPanelResize, settlePanelResize } from '../lib/panelResize'

interface Props {
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
 * 工作区网格的侧栏槽：展开 / 收起时宽度在 0 与侧栏宽度之间过渡，编辑区随之平移，不再瞬间跳动。
 * 动画期间内容贴右对齐并裁切，看起来像抽屉从活动栏一侧滑出；中途反向（快速连点）从当前宽度接着播。
 */
export default function SidebarSlot({ leaving, onExited, animateOpen, freezeTerminals, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const slotAnimation = useRef<Animation | null>(null)
  const contentAnimation = useRef<Animation | null>(null)
  const frozen = useRef(false)
  const mounted = useRef(false)
  const onExitedRef = useRef(onExited)
  const freezeRef = useRef(freezeTerminals)

  useLayoutEffect(() => {
    onExitedRef.current = onExited
    freezeRef.current = freezeTerminals
  })

  useLayoutEffect(() => {
    const slot = ref.current
    const first = !mounted.current
    mounted.current = true
    if (!slot || (first && !leaving && !animateOpen)) return

    const content = slot.firstElementChild instanceof HTMLElement ? slot.firstElementChild : null
    // 取消前先读当前（可能还在动画中的）宽度和透明度，反向时从这里接着播。
    const fromWidth = first ? 0 : slot.getBoundingClientRect().width
    const computedOpacity = content ? parseFloat(getComputedStyle(content).opacity) : 1
    const fromOpacity = Number.isFinite(computedOpacity) ? computedOpacity : 1
    slotAnimation.current?.cancel()
    contentAnimation.current?.cancel()
    slotAnimation.current = null
    contentAnimation.current = null

    const fullWidth = content?.getBoundingClientRect().width ?? 0
    const toWidth = leaving ? 0 : fullWidth
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

    if (!canAnimateLayout(slot) || !fullWidth || Math.abs(fromWidth - toWidth) < 1) {
      settle()
      if (leaving) onExitedRef.current()
      return
    }

    const base = leaving ? cssDuration('--motion-view-exit', 160) : cssDuration('--motion-view', 200)
    const duration = Math.max(60, base * (Math.abs(toWidth - fromWidth) / fullWidth))
    const timing: KeyframeAnimationOptions = { duration, easing: EASE_SOFT, fill: 'forwards' }

    slot.style.overflow = 'hidden'
    slot.style.justifyContent = 'flex-end'
    if (freezeRef.current && !frozen.current) {
      frozen.current = true
      beginPanelResize('vertical', { cursor: false })
    }

    const animation = slot.animate([{ width: `${fromWidth}px` }, { width: `${toWidth}px` }], timing)
    slotAnimation.current = animation
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
      animation.cancel()
      contentAnimation.current?.cancel()
      slotAnimation.current = null
      contentAnimation.current = null
      settle()
    }
  }, [leaving, animateOpen])

  useLayoutEffect(() => () => {
    slotAnimation.current?.cancel()
    contentAnimation.current?.cancel()
    if (frozen.current) {
      frozen.current = false
      settlePanelResize('vertical')
    }
  }, [])

  return (
    <div ref={ref} className="workspace-grid-sidebar flex" inert={leaving || undefined}>
      {children}
    </div>
  )
}
