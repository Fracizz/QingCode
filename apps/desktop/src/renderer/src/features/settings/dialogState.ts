import { create } from 'zustand'
import { isSettingsSection, type SettingsSectionId } from './settingsModel'

/** 统一侧栏、快捷键与命令面板的设置页入口。 */
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
