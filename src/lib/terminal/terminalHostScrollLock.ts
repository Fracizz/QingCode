/**
 * 锁住终端宿主容器的滚动位置。
 *
 * 宿主容器都是 overflow:hidden，但浏览器仍会为了让获得焦点的 xterm helper textarea /
 * 输入法组字框（composition-view）保持可见而以编程方式滚动它们：光标贴近底部、组字串
 * 换行变高时，整个终端画面会被“顶”上去，底部留出空白（TUI 输入框看起来自动上移）。
 * 这些容器本身从不需要滚动（回滚历史由 .xterm-viewport 负责，不在此列），发现偏移即归零。
 */
export function lockTerminalHostScroll(elements: Array<HTMLElement | null | undefined>): () => void {
  const targets = elements.filter((element): element is HTMLElement => !!element)
  const reset = (event: Event) => {
    const element = event.currentTarget as HTMLElement
    if (element.scrollTop !== 0) element.scrollTop = 0
    if (element.scrollLeft !== 0) element.scrollLeft = 0
  }
  for (const element of targets) {
    element.addEventListener('scroll', reset, { passive: true })
    // 挂载时可能已经偏移（例如上次组字遗留），先归零一次。
    element.scrollTop = 0
    element.scrollLeft = 0
  }
  return () => {
    for (const element of targets) element.removeEventListener('scroll', reset)
  }
}
