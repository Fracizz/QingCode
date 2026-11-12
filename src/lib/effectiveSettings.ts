import { notifyShellPrewarmChanged } from './terminal/shellPrewarmSettings'
import type { Project } from '../types'
import {
  loadEffectiveAutoSaveSettings,
  migrateLegacyProjectAutoSaveDefaults,
  notifyAutoSaveSettingsChanged,
} from './autoSaveSettings'
import { loadEffectiveEditorPreferences } from './editorSettings'
import { loadEffectiveExcludeSettings } from './excludeSettings'
import { loadEffectiveFileSizePreferences } from './fileSizeSettings'
import { loadEffectiveTerminalScrollback } from './terminal/terminalScrollbackSettings'
import { loadEditorStateCacheSize } from './editorStateCacheSettings'

/**
 * Apply the complete global + project settings overlay to runtime modules.
 * Callers own any feature-specific follow-up work (for example tree refresh).
 */
export async function applyEffectiveSettings(project?: Project | null): Promise<void> {
  const [formatOnSave, minimap, terminalCursor, persistLocal] = await Promise.all([
    import('./formatOnSaveSettings'),
    import('./minimapSettings'),
    import('./terminal/terminalCursorSettings'),
    import('./terminal/terminalPersistLocalSettings'),
  ])

  await Promise.all([
    minimap.migrateLegacyMinimapProjectSetting(project),
    migrateLegacyProjectAutoSaveDefaults(project),
  ])
  // 与上面的工作区迁移分开跑：它们会改写同一个 project-settings.json。
  await persistLocal.migrateLegacyPersistLocalSessions(project)
  const [, , autoSave] = await Promise.all([
    loadEffectiveEditorPreferences(project),
    loadEffectiveFileSizePreferences(project),
    loadEffectiveAutoSaveSettings(project),
    formatOnSave.loadEffectiveFormatOnSave(project),
    minimap.loadEffectiveMinimapEnabled(project),
    loadEffectiveTerminalScrollback(project),
    loadEditorStateCacheSize(),
    terminalCursor.loadEffectiveTerminalCursorBlinking(project),
    import('./terminal/terminalSshUploadSettings').then(mod =>
      mod.loadEffectiveTerminalSshUploadOnPaste(project),
    ),
    import('./terminal/terminalLargePasteSettings').then(mod =>
      mod.loadEffectiveTerminalLargePasteAsFile(project),
    ),
    import('./terminal/terminalActivitySettings').then(mod =>
      mod.loadEffectiveTerminalActivityIndicator(project),
    ),
    import('./terminal/terminalShiftEnterSettings').then(mod =>
      mod.loadEffectiveTerminalShiftEnterNewline(project),
    ),
    persistLocal.loadEffectiveTerminalPersistLocalSessions(project),
    loadEffectiveExcludeSettings(project),
  ])
  notifyAutoSaveSettingsChanged(autoSave)
  notifyShellPrewarmChanged()
}
