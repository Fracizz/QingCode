import type { Project } from '../types'
import { loadEffectiveAutoSaveSettings, notifyAutoSaveSettingsChanged } from './autoSaveSettings'
import { loadEffectiveEditorPreferences } from './editorSettings'
import { loadEffectiveExcludeSettings } from './excludeSettings'
import { loadEffectiveFileSizePreferences } from './fileSizeSettings'
import { loadEffectiveTerminalScrollback } from './terminal/terminalScrollbackSettings'
import { loadEditorStateCacheSize } from './editorStateCacheSettings'
import { loadWindowsFileReadMode } from './windowsFileReadModeSettings'

/**
 * Apply the complete global + project settings overlay to runtime modules.
 * Callers own any feature-specific follow-up work (for example tree refresh).
 */
export async function applyEffectiveSettings(project?: Project | null): Promise<void> {
  const [formatOnSave, minimap, terminalCursor] = await Promise.all([
    import('./formatOnSaveSettings'),
    import('./minimapSettings'),
    import('./terminal/terminalCursorSettings'),
  ])

  await minimap.migrateLegacyMinimapProjectSetting(project)
  const [, , autoSave] = await Promise.all([
    loadEffectiveEditorPreferences(project),
    loadEffectiveFileSizePreferences(project),
    loadEffectiveAutoSaveSettings(project),
    formatOnSave.loadEffectiveFormatOnSave(project),
    minimap.loadEffectiveMinimapEnabled(project),
    loadEffectiveTerminalScrollback(project),
    loadEditorStateCacheSize(),
    terminalCursor.loadEffectiveTerminalCursorBlinking(project),
    loadEffectiveExcludeSettings(project),
    loadWindowsFileReadMode(),
  ])
  notifyAutoSaveSettingsChanged(autoSave)
}
