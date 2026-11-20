import { useLayoutEffect, useRef, type RefObject } from 'react'
import { fadeInSubpage } from '../lib/layoutMotion'

/** 只有子页身份变化才淡入，保留正文容器和同一页的状态。 */
export function useSubpageFade(content: RefObject<HTMLElement | null>, page: string, enabled = true) {
  const previous = useRef(page)
  useLayoutEffect(() => {
    const changed = previous.current !== page
    previous.current = page
    if (!changed || !enabled) return
    const fade = fadeInSubpage(content.current)
    return () => fade?.cancel()
  }, [content, page, enabled])
}
