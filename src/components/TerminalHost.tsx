import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const TerminalView = lazy(() => import('./Terminal'))

/**
 * 终端视图常驻宿主，做法同 VS Code 的 `xterm.attachToElement`：
 * 每个终端一个固定的游离 DOM 节点，TerminalView 通过 portal 一直渲染在节点里；
 * 切换项目、分格或布局时只把节点挂到新的槽位，xterm 不销毁、不重放历史。
 * 没有槽位时节点游离在文档外，xterm 继续解析输出、暂停绘制，挂回来即是当前画面。
 */
const hostNodes = new Map<string, HTMLDivElement>()

function terminalHostNode(terminalId: string): HTMLDivElement {
  let node = hostNodes.get(terminalId)
  if (!node) {
    node = document.createElement('div')
    node.className = 'h-full w-full'
    node.dataset.terminalHost = terminalId
    hostNodes.set(terminalId, node)
  }
  return node
}

export interface TerminalHostEntry {
  terminalId: string
  isActive: boolean
}

/** 渲染所有常驻终端视图。必须放在不随布局切换而重建的位置。 */
export function TerminalHosts({
  entries,
  layoutKey,
}: {
  entries: readonly TerminalHostEntry[]
  layoutKey: string
}) {
  const liveIds = entries.map(entry => entry.terminalId).join('\n')
  useEffect(() => {
    // 标签关闭后 portal 已卸载，这里回收它的节点。
    const live = new Set(liveIds ? liveIds.split('\n') : [])
    for (const [terminalId, node] of hostNodes) {
      if (live.has(terminalId)) continue
      node.remove()
      hostNodes.delete(terminalId)
    }
  }, [liveIds])

  return (
    <>
      {entries.map(entry =>
        createPortal(
          <Suspense fallback={null}>
            <TerminalView
              terminalId={entry.terminalId}
              isActive={entry.isActive}
              layoutKey={layoutKey}
            />
          </Suspense>,
          terminalHostNode(entry.terminalId),
          entry.terminalId
        )
      )}
    </>
  )
}

/**
 * 终端在布局里的位置：只负责把常驻节点挂进来。
 * portal 内的 React 事件沿 React 树冒泡、不经过槽位外层，点击终端激活窗格要用原生监听。
 */
export function TerminalSlot({
  terminalId,
  onPointerDown,
}: {
  terminalId: string
  onPointerDown?: () => void
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const pointerDownRef = useRef(onPointerDown)
  useEffect(() => {
    pointerDownRef.current = onPointerDown
  }, [onPointerDown])

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    const node = terminalHostNode(terminalId)
    slot.appendChild(node)
    const handlePointerDown = () => pointerDownRef.current?.()
    slot.addEventListener('pointerdown', handlePointerDown)
    return () => {
      slot.removeEventListener('pointerdown', handlePointerDown)
      // 节点可能已被新槽位接走，只摘自己名下的。
      if (node.parentElement === slot) slot.removeChild(node)
    }
  }, [terminalId])

  return <div ref={slotRef} className="h-full w-full" />
}
