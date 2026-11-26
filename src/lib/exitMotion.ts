// 浮层退出动效（见 DESIGN.md「动效一览」）：弹窗、菜单、通知由 React 直接卸载，
// 卸载前克隆一份只读「残影」留在原处淡出，组件的开关逻辑和 close 时机都不变。
// 新的弹窗或菜单出现时清掉还没播完的残影（交接），只播下一层的入场，避免一出一进两段动画叠在一起。
import { useCallback, type RefCallback, type RefObject } from 'react'
import { motionReduced } from './motionPreferences'

/** float：编辑区 / 终端里绝对定位的浮条与角标，残影留在原父节点内，不参与弹窗与菜单的交接。 */
export type ExitKind = 'modal' | 'menu' | 'toast' | 'float'

interface Ghost {
  kind: ExitKind
  node: HTMLElement
  animation: Animation
  timer: ReturnType<typeof setTimeout>
}

const ghosts = new Set<Ghost>()

/** 与 animations.css 中 --ease-exit 一致：加速离场。 */
const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)'
const FALLBACK_EXIT_MS = 100

/** 退出时长取 CSS 变量 --motion-exit，参数只维护在 animations.css 一处。 */
function exitDuration(): number {
  try {
    const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-exit'))
    if (Number.isFinite(value) && value > 0) return value
  } catch {}
  return FALLBACK_EXIT_MS
}

/** 保留输入框、滚动位置和弹窗仍在入场时的透明度。 */
function copyLiveState(source: HTMLElement, clone: HTMLElement, modal: boolean) {
  const a = document.createTreeWalker(source, NodeFilter.SHOW_ELEMENT)
  const b = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT)
  let from: Node | null = source
  let to: Node | null = clone
  while (from && to) {
    const s = from as HTMLElement
    const c = to as HTMLElement
    if (s instanceof HTMLInputElement || s instanceof HTMLTextAreaElement || s instanceof HTMLSelectElement) {
      ;(c as HTMLInputElement).value = s.value
      if (s instanceof HTMLInputElement) (c as HTMLInputElement).checked = s.checked
    }
    if (s.scrollTop || s.scrollLeft) {
      // 克隆插入文档后才能滚动，先记下来。
      c.dataset.exitScroll = `${s.scrollTop},${s.scrollLeft}`
    }
    if (modal && s !== source && s.matches('.modal-overlay-enter, .modal-content-enter')) {
      c.style.opacity = getComputedStyle(s).opacity
    }
    from = a.nextNode()
    to = b.nextNode()
  }
}

function restoreScroll(clone: HTMLElement) {
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('[data-exit-scroll]')]) {
    const saved = el.dataset.exitScroll
    if (!saved) continue
    const [top, left] = saved.split(',').map(Number)
    el.scrollTop = top
    el.scrollLeft = left
    delete el.dataset.exitScroll
  }
}

/** 残影不可聚焦、不可点击、对读屏隐藏；去掉 id / role / data-testid 及根节点的 data 标记，避免被查询或快捷键逻辑当成真实浮层。 */
function sanitize(clone: HTMLElement) {
  for (const name of clone.getAttributeNames()) {
    if (name.startsWith('data-') && name !== 'data-exit-scroll') clone.removeAttribute(name)
  }
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('[id], [role], [data-modal-autofocus], [data-testid]')]) {
    el.removeAttribute('id')
    el.removeAttribute('role')
    el.removeAttribute('data-modal-autofocus')
    el.removeAttribute('data-testid')
  }
  clone.setAttribute('inert', '')
  clone.setAttribute('aria-hidden', 'true')
  clone.dataset.exitGhost = ''
  clone.style.pointerEvents = 'none'
}

function removeGhost(ghost: Ghost) {
  if (!ghosts.delete(ghost)) return
  clearTimeout(ghost.timer)
  try { ghost.animation.cancel() } catch {}
  ghost.node.remove()
}

/**
 * 在 element 被移除前留下残影，从当前透明度原位淡出。
 * 减少动效、窗口在后台或环境不支持 Web Animations（如 jsdom）时什么都不做。
 */
export function leaveExitGhost(element: HTMLElement, kind: ExitKind) {
  if (typeof document === 'undefined' || !element.isConnected) return
  if (typeof element.animate !== 'function' || motionReduced() || document.visibilityState === 'hidden') return

  const opacity = getComputedStyle(element).opacity || '1'
  const nestedModal = kind === 'modal' && element.dataset.modalNested !== undefined
  const clone = element.cloneNode(true) as HTMLElement
  copyLiveState(element, clone, kind === 'modal')
  sanitize(clone)
  // sanitize 去掉了根节点 data-modal-nested，嵌套弹窗的透明遮罩要用行内样式保住，否则残影会闪出一层深色模糊遮罩。
  const nestedPanels: HTMLElement[] = []
  if (nestedModal) {
    for (const child of clone.children) {
      if (!(child instanceof HTMLElement)) continue
      if (child.classList.contains('modal-overlay-enter')) {
        child.style.background = 'transparent'
        child.style.backdropFilter = 'none'
      } else if (child.classList.contains('modal-content-enter')) {
        nestedPanels.push(child)
      }
    }
  }

  if (kind === 'toast') {
    // 通知在纵向堆栈里，残影脱离堆栈固定在原位，其余通知立即补位。
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const stackZ = element.parentElement ? getComputedStyle(element.parentElement).zIndex : ''
    Object.assign(clone.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      zIndex: stackZ && stackZ !== 'auto' ? stackZ : '150',
    })
    document.body.appendChild(clone)
  } else {
    // 弹窗与菜单本身是 fixed 定位，浮条在终端 / 编辑区容器内绝对定位：放在原节点后面即可保持位置和继承的样式。
    element.after(clone)
  }
  restoreScroll(clone)

  const duration = exitDuration()
  const timing: KeyframeAnimationOptions = { duration, easing: EASE_EXIT, fill: 'forwards' }
  const animation = clone.animate([{ opacity }, { opacity: 0 }], timing)
  // 嵌套弹窗面板沿入场方向反向沉下（与 animations.css 的 modal-content-rise 对应），整体透明度仍由根节点统一淡出。
  for (const panel of nestedPanels) {
    panel.animate([{ transform: 'none' }, { transform: 'translateY(4px) scale(0.98)' }], timing)
  }

  const ghost: Ghost = { kind, node: clone, animation, timer: setTimeout(() => removeGhost(ghost), duration + 100) }
  ghosts.add(ghost)
  animation.finished.then(() => removeGhost(ghost), () => removeGhost(ghost))
}

/**
 * 新浮层出现时的交接：弹窗清掉未播完的弹窗与菜单残影，菜单清掉菜单残影。
 * 被替换的是弹窗时给新弹窗打 data-modal-handoff，遮罩不重新淡入，保持连续。
 */
export function handoffExitGhosts(kind: ExitKind, entering: HTMLElement) {
  if (kind === 'toast' || kind === 'float') return
  let replacedModal = false
  for (const ghost of [...ghosts]) {
    if (ghost.kind === 'toast' || ghost.kind === 'float' || (kind === 'menu' && ghost.kind !== 'menu')) continue
    if (ghost.kind === 'modal') replacedModal = true
    removeGhost(ghost)
  }
  if (replacedModal) entering.dataset.modalHandoff = ''
}

/** 仅测试用：清空残影。 */
export function clearExitGhostsForTest() {
  for (const ghost of [...ghosts]) removeGhost(ghost)
}

/**
 * 给浮层根节点用的 ref：挂载时做交接，卸载时留下残影。可同时写入已有的对象 ref。
 * 同一任务内挂上又卸下（如 StrictMode 开发期的双调用）不留残影，那一帧从未绘制。
 */
export function useExitMotionRef<T extends HTMLElement>(
  kind: ExitKind,
  ref?: RefObject<T | null> | null,
): RefCallback<T> {
  return useCallback((node: T | null) => {
    if (ref) ref.current = node
    if (!node) return
    handoffExitGhosts(kind, node)
    let painted = false
    queueMicrotask(() => { painted = true })
    return () => {
      if (ref && ref.current === node) ref.current = null
      if (painted) leaveExitGhost(node, kind)
    }
  }, [kind, ref])
}
