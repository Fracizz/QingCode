import { useMemo, useSyncExternalStore } from 'react'
import { FONT_SETTINGS_EVENT } from '../lib/fontSettings'
import { interfaceMetrics, INTERFACE_BASE_FONT_SIZE } from '../lib/interfaceMetrics'

function subscribe(onChange: () => void) {
  window.addEventListener(FONT_SETTINGS_EVENT, onChange)
  return () => window.removeEventListener(FONT_SETTINGS_EVENT, onChange)
}

function readFontSize() {
  return Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-font-size')) || INTERFACE_BASE_FONT_SIZE
}

/** Virtual rows and overflow measurements must update when the selected UI font changes. */
export function useInterfaceMetrics() {
  const fontSize = useSyncExternalStore(subscribe, readFontSize, () => INTERFACE_BASE_FONT_SIZE)
  return useMemo(() => interfaceMetrics(fontSize), [fontSize])
}
