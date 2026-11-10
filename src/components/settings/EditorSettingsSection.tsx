import { useI18n } from '../../lib/i18n'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_OPTIONS,
  MONO_FONT_OPTIONS,
  type FontSettings,
} from '../../lib/fontSettings'
import { DEFAULT_GLOBAL_SETTINGS } from '../../lib/projectSettings'
import {
  AUTO_SAVE_DELAY_OPTIONS,
  AUTO_SAVE_MODES,
  type AutoSaveMode,
} from '../../lib/autoSaveSettings'
import FontFamilySelect from '../FontFamilySelect'
import { SettingItem } from '../SettingsLayout'
import type { EditorFileSettingsState } from './useSettingsSectionState'
import type { FontSettingUpdater, SettingsMatch } from './types'

type Props = {
  match: SettingsMatch
  workspaceLocked: boolean
  /** workspace 作用域但未选择项目：作用域相关设置不可编辑。 */
  projectMissing: boolean
  fonts: FontSettings
  onFontChange: FontSettingUpdater
  settings: EditorFileSettingsState
}

/** 编辑器与文件分区：参考线、小地图、自动保存、编辑器字体，以及 JSON 键说明。 */
export default function EditorSettingsSection({
  match,
  workspaceLocked,
  projectMissing,
  fonts,
  onFontChange,
  settings,
}: Props) {
  const { t } = useI18n()
  const {
    autoSaveMode,
    autoSaveDelay,
    minimapEnabled,
    editorGuidesEnabled,
    updateAutoSave,
    updateMinimapEnabled,
    updateEditorGuidesEnabled,
  } = settings

  return (
    <>
      {match('参考线', '缩进线', '括号线', 'editor.guides.enabled') && (
        <SettingItem
          title={t('编辑器: 参考线')}
          description={t('控制普通缩进线、活动高亮线和括号参考线。关闭后这些线全部隐藏。')}
          modified={editorGuidesEnabled !== DEFAULT_GLOBAL_SETTINGS['editor.guides.enabled']}
          locked={projectMissing}
          lockHint={t('请先选择项目，再配置工作区编辑器参考线。')}
        >
          <select
            value={editorGuidesEnabled ? 'on' : 'off'}
            disabled={projectMissing}
            onChange={e => void updateEditorGuidesEnabled(e.target.value === 'on')}
            className="setting-control setting-select"
            aria-label={t('编辑器: 参考线')}
          >
            <option value="on">{t('开启')}</option>
            <option value="off">{t('关闭')}</option>
          </select>
        </SettingItem>
      )}
      {match('小地图', 'minimap', 'editor.minimap.enabled') && (
        <SettingItem
          title={t('编辑器: 小地图')}
          description={t('在编辑区右侧显示代码缩略图，便于快速跳转。大于 5MB 的文件会自动隐藏。')}
          modified={minimapEnabled !== DEFAULT_GLOBAL_SETTINGS['editor.minimap.enabled']}
          locked={projectMissing}
          lockHint={t('请先选择项目，再配置工作区小地图。')}
        >
          <select
            value={minimapEnabled ? 'on' : 'off'}
            disabled={projectMissing}
            onChange={e => void updateMinimapEnabled(e.target.value === 'on')}
            className="setting-control setting-select"
            aria-label={t('编辑器: 小地图')}
          >
            <option value="on">{t('开启')}</option>
            <option value="off">{t('关闭')}</option>
          </select>
        </SettingItem>
      )}
      {match('自动保存', 'files.autoSave') && (
        <>
          <SettingItem
            title={t('文件: 自动保存')}
            description={t('控制具有未保存更改的编辑器何时自动保存。')}
            modified={
              autoSaveMode !== DEFAULT_GLOBAL_SETTINGS['files.autoSave'] ||
              autoSaveDelay !== DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay']
            }
            locked={projectMissing}
            lockHint={t('请先选择项目，再配置工作区自动保存。')}
          >
            <select
              value={autoSaveMode}
              disabled={projectMissing}
              onChange={e => void updateAutoSave(e.target.value as AutoSaveMode)}
              className="setting-control setting-control-wide setting-select"
            >
              {AUTO_SAVE_MODES.map(option => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </SettingItem>
          {autoSaveMode === 'afterDelay' && (
            <SettingItem
              title={t('文件: 自动保存延迟')}
              description={t('在 afterDelay 模式下，停止编辑后等待多久再保存（毫秒）。')}
              modified={autoSaveDelay !== DEFAULT_GLOBAL_SETTINGS['files.autoSaveDelay']}
              locked={projectMissing}
              lockHint={t('请先选择项目，再配置工作区自动保存。')}
            >
              <select
                value={autoSaveDelay}
                disabled={projectMissing}
                onChange={e => void updateAutoSave(autoSaveMode, Number(e.target.value))}
                className="setting-control setting-select"
              >
                {AUTO_SAVE_DELAY_OPTIONS.map(delay => (
                  <option key={delay} value={delay}>
                    {delay} ms
                  </option>
                ))}
              </select>
            </SettingItem>
          )}
        </>
      )}
      {!workspaceLocked && match('代码字体', '编辑器字号') && (
        <>
          <SettingItem
            title={t('编辑器: 字体族')}
            description={t('控制编辑器字体族。可选择本机已安装字体。')}
            modified={fonts.monoFont !== DEFAULT_FONT_SETTINGS.monoFont}
            locked={workspaceLocked}
            lockHint={t('此设置仅在用户作用域中可用')}
          >
            <FontFamilySelect
              value={fonts.monoFont}
              presets={MONO_FONT_OPTIONS}
              kind="mono"
              disabled={workspaceLocked}
              aria-label={t('编辑器: 字体族')}
              onChange={value => onFontChange('monoFont', value)}
            />
          </SettingItem>
          <SettingItem
            title={t('编辑器: 字号')}
            description={t('控制编辑器中的字号（像素），对应用户设置 editor.fontSize。')}
            modified={fonts.editorFontSize !== DEFAULT_FONT_SETTINGS.editorFontSize}
            locked={workspaceLocked}
            lockHint={t('此设置仅在用户作用域中可用')}
          >
            <select
              value={fonts.editorFontSize}
              disabled={workspaceLocked}
              onChange={e => onFontChange('editorFontSize', Number(e.target.value))}
              className="setting-control setting-select"
            >
              {FONT_SIZE_OPTIONS.map(size => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </SettingItem>
        </>
      )}
      {match(
        '打开设置 JSON',
        'JSON5',
        'files.exclude',
        'search.exclude',
        'files.encoding',
        'files.eol',
        'editor.tabSize',
        'editor.wordWrap',
        '不计划',
      ) && (
        <SettingItem
          title={t('JSON 键生效说明')}
          description={t(
            'files.exclude / search.exclude / useIgnoreFiles / followSymlinks、explorer.excludeGitIgnore、files.encoding、editor.minimap.enabled、editor.formatOnSave / formatOnPaste、括号着色与参考线、terminal.integrated.scrollback / cursorBlinking / sshUploadOnPaste 已生效。标有「不计划」的键（如 linkedEditing）会保存但不会改变行为。详见帮助文档。',
          )}
        >
          <span className="text-ui-sm text-fg-dim">{t('管理设置 → 打开设置 JSON')}</span>
        </SettingItem>
      )}
    </>
  )
}
