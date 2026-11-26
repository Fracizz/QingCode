import { SETTINGS_SECTIONS, openSettings, type SettingsSectionId } from '../settings'
import { TERMINAL_SHORTCUT, useTerminalDock } from '../terminal/dockState'
import { useCodex } from '../../store/codex'
import { useDock } from '../../store/dock'
import { useLegacy } from '../../store/legacy'
import { useUi } from '../../store/ui'
import type { DefaultCommandDeps } from './defaultCommands'

/**
 * 把全局 store 里现成的动作接成 defaultCommands 的依赖，App 只需再补上自己局部 state 管的
 * 动作（快速打开、添加连接、手机连接等）。放在单独文件，defaultCommands 本身保持纯净可测。
 */
export function storeCommandDeps(): DefaultCommandDeps<SettingsSectionId> {
  return {
    toggleDockTool: (tool) => useDock.getState().toggleTool(tool),
    hideDockTool: () => useDock.getState().hideTool(),
    toggleSidebar: () => useUi.getState().toggleSidebar(),
    toggleTerminal: useTerminalDock.getState().toggle,
    terminalShortcut: TERMINAL_SHORTCUT,
    addProject: () => useUi.getState().openDirectoryPicker(),
    newThread: () => useCodex.getState().startDraft(),
    interrupt: () => useCodex.getState().interrupt(),
    openSettings: (section) => openSettings(section),
    settingsSections: SETTINGS_SECTIONS,
    importLegacy: () => useLegacy.getState().open(),
    reloadWindow: () => window.location.reload(),
  }
}
