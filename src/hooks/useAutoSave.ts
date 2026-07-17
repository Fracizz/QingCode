import { useEffect, useRef } from 'react'
import { isTauri } from '../lib/tauri'
import {
  applyAutoSaveSettings,
  notifyActiveEditorChanged,
  notifyWindowBlur,
  refreshAutoSaveSettings,
} from '../lib/autoSave'
import { AUTO_SAVE_SETTINGS_EVENT } from '../lib/autoSaveSettings'
import { isSettingsJsonPath } from '../lib/projectSettings'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'

export function useAutoSave() {
  const activeTabId = useEditorStore(s => s.activeTabId)
  const currentProject = useProjectStore(s => s.currentProject)
  const previousTabIdRef = useRef<string | null>(activeTabId)

  useEffect(() => {
    void refreshAutoSaveSettings(currentProject)
  }, [currentProject])

  useEffect(() => {
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail && typeof detail === 'object' && 'mode' in detail) {
        applyAutoSaveSettings(detail as { mode: typeof detail.mode; delay: number })
      } else {
        void refreshAutoSaveSettings(currentProject)
      }
    }
    window.addEventListener(AUTO_SAVE_SETTINGS_EVENT, onSettingsChanged)
    return () => window.removeEventListener(AUTO_SAVE_SETTINGS_EVENT, onSettingsChanged)
  }, [currentProject])

  useEffect(() => {
    const previousTabId = previousTabIdRef.current
    if (previousTabId !== activeTabId) {
      notifyActiveEditorChanged(previousTabId)
      previousTabIdRef.current = activeTabId
    }
  }, [activeTabId])

  useEffect(() => {
    const onWindowBlur = () => notifyWindowBlur()
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) notifyWindowBlur()
      }).then(fn => {
        unlisten = fn
      })
    })
    return () => unlisten?.()
  }, [])

  useEffect(() => {
    return useEditorStore.subscribe((state, previous) => {
      const savedTab = state.tabs.find(tab => {
        const before = previous.tabs.find(item => item.id === tab.id)
        return before?.dirty && !tab.dirty && isSettingsJsonPath(tab.path)
      })
      if (savedTab) void refreshAutoSaveSettings(currentProject)
    })
  }, [currentProject])
}
