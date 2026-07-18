/** Mirror vertical scroll progress from `source` onto `target` (0–1 of max scroll). */
export function syncScrollTop(source: HTMLElement, target: HTMLElement) {
  const maxSource = source.scrollHeight - source.clientHeight
  const maxTarget = target.scrollHeight - target.clientHeight
  if (maxTarget <= 0) {
    target.scrollTop = 0
    return
  }
  if (maxSource <= 0) {
    target.scrollTop = 0
    return
  }
  target.scrollTop = (source.scrollTop / maxSource) * maxTarget
}
