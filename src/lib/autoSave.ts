import type { Project } from '../types'
import { useEditorStore } from '../store/editorStore'
import { loadEffectiveAutoSaveSettings, type AutoSaveSettings } from './autoSaveSettings'

let current: AutoSaveSettings = { mode: 'off', delay: 1000 }
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(tabId: string) {
  const timer = timers.get(tabId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(tabId)
  }
}

function clearAllTimers() {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

export function getAutoSaveSettings(): AutoSaveSettings {
  return current
}

export function isAutoSaveEnabled(): boolean {
  return current.mode !== 'off'
}

export async function refreshAutoSaveSettings(project?: Project | null) {
  current = await loadEffectiveAutoSaveSettings(project)
  if (current.mode !== 'afterDelay') clearAllTimers()
}

export function applyAutoSaveSettings(settings: AutoSaveSettings) {
  current = settings
  if (current.mode !== 'afterDelay') clearAllTimers()
}

async function saveTabIfDirty(tabId: string) {
  clearTimer(tabId)
  const tab = useEditorStore.getState().tabs.find(item => item.id === tabId)
  if (!tab?.dirty) return
  await useEditorStore.getState().saveFile(tabId)
}

async function saveTabsIfDirty(tabIds: string[]) {
  await Promise.all(tabIds.map(tabId => saveTabIfDirty(tabId)))
}

export async function flushAutoSave(tabIds?: string[]) {
  if (current.mode === 'off') return
  clearAllTimers()
  const tabs = useEditorStore.getState().tabs
  const targets =
    tabIds?.length
      ? tabs.filter(tab => tabIds.includes(tab.id))
      : tabs
  await saveTabsIfDirty(targets.filter(tab => tab.dirty).map(tab => tab.id))
}

export function notifyEditorContentChanged(tabId: string) {
  if (current.mode !== 'afterDelay') return
  clearTimer(tabId)
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId)
      void saveTabIfDirty(tabId)
    }, current.delay),
  )
}

export function notifyActiveEditorChanged(previousTabId: string | null) {
  if (current.mode === 'off') return
  if (current.mode === 'afterDelay' || current.mode === 'onFocusChange') {
    if (previousTabId) void saveTabIfDirty(previousTabId)
  }
}

export function notifyEditorBlur() {
  if (current.mode !== 'onFocusChange') return
  const activeTabId = useEditorStore.getState().activeTabId
  if (activeTabId) void saveTabIfDirty(activeTabId)
}

export function notifyWindowBlur() {
  if (current.mode === 'off') return
  if (current.mode === 'onWindowChange') {
    void flushAutoSave()
    return
  }
  if (current.mode === 'onFocusChange') {
    const activeTabId = useEditorStore.getState().activeTabId
    if (activeTabId) void saveTabIfDirty(activeTabId)
  }
}

export function shouldAutoSaveBeforeDiscard(): boolean {
  return current.mode !== 'off'
}
