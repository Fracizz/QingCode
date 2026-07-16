const RESIZING_CLASS = 'panel-resizing'

export function beginPanelResize() {
  document.body.classList.add(RESIZING_CLASS)
  document.body.style.userSelect = 'none'
}

export function endPanelResize() {
  document.body.classList.remove(RESIZING_CLASS)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
}
