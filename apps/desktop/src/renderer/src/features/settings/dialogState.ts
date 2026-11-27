import { create } from 'zustand'
import { isSettingsSection, type SettingsSectionId } from './settingsModel'

/** 全局开关：侧栏齿轮按钮与 Ctrl+, 快捷键都调用 openSettings，宿主只需渲染一次 SettingsDialog。 */
export type SettingsDialogState = {
  open: boolean
  section?: SettingsSectionId
  openSettings: (section?: SettingsSectionId) => void
  closeSettings: () => void
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  section: undefined,
  openSettings: (section) =>
    set({ open: true, section: isSettingsSection(section) ? section : undefined }),
  closeSettings: () => set({ open: false, section: undefined }),
}))

export function openSettings(section?: SettingsSectionId): void {
  useSettingsDialog.getState().openSettings(section)
}

export function closeSettings(): void {
  useSettingsDialog.getState().closeSettings()
}
