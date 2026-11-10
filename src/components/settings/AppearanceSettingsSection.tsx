import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useI18n } from '../../lib/i18n'
import { isTauri, safeInvoke } from '../../lib/tauri'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SIZE_OPTIONS,
  INTERFACE_FONT_OPTIONS,
  type FontSettings,
} from '../../lib/fontSettings'
import { DEFAULT_THEME, THEMES, type AppTheme } from '../../lib/themeSettings'
import { useProjectStore } from '../../store/projectStore'
import FontFamilySelect from '../FontFamilySelect'
import SettingSelect from '../SettingSelect'
import { SettingItem } from '../SettingsLayout'
import type { FontSettingUpdater, SettingsMatch } from './types'

type Props = {
  match: SettingsMatch
  workspaceLocked: boolean
  theme: AppTheme
  onThemeChange: (value: AppTheme) => void
  fonts: FontSettings
  onFontChange: FontSettingUpdater
}

/** 外观与语言分区：颜色主题、界面字号 / 字体、显示语言、自定义语言包。 */
export default function AppearanceSettingsSection({
  match,
  workspaceLocked,
  theme,
  onThemeChange,
  fonts,
  onFontChange,
}: Props) {
  const { t, language, setLanguage, localeOptions, reloadUserLocales } = useI18n()
  const pushToast = useProjectStore(s => s.pushToast)

  return (
    <>
      {match('颜色主题', '外观', '深色', '浅色') && (
        <SettingItem
          title={t('颜色主题')}
          description={t('指定 QingCode 使用的颜色主题。选择“跟随系统”时随操作系统明暗切换。')}
          modified={theme !== DEFAULT_THEME}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <SettingSelect
            value={theme}
            disabled={workspaceLocked}
            aria-label={t('颜色主题')}
            onChange={next => onThemeChange(next as AppTheme)}
            options={THEMES.map(option => ({
              value: option.value,
              label: t(option.label),
            }))}
          />
        </SettingItem>
      )}
      {match('界面字号') && (
        <SettingItem
          title={t('界面字号')}
          description={t('控制菜单、标题栏、侧栏、标签和状态栏的字号（像素）。')}
          modified={fonts.interfaceFontSize !== DEFAULT_FONT_SETTINGS.interfaceFontSize}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <SettingSelect
            value={String(fonts.interfaceFontSize)}
            disabled={workspaceLocked}
            aria-label={t('界面字号')}
            onChange={next => onFontChange('interfaceFontSize', Number(next))}
            options={FONT_SIZE_OPTIONS.map(size => ({
              value: String(size),
              label: String(size),
            }))}
          />
        </SettingItem>
      )}
      {match('界面字体') && (
        <SettingItem
          title={t('界面字体')}
          description={t('用于菜单、标题栏、侧栏、标签和状态栏的字体族。可选择本机已安装字体。')}
          modified={fonts.interfaceFont !== DEFAULT_FONT_SETTINGS.interfaceFont}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <FontFamilySelect
            value={fonts.interfaceFont}
            presets={INTERFACE_FONT_OPTIONS}
            kind="sans"
            disabled={workspaceLocked}
            aria-label={t('界面字体')}
            onChange={value => onFontChange('interfaceFont', value)}
          />
        </SettingItem>
      )}
      {match('显示语言', '语言') && (
        <SettingItem
          title={t('显示语言')}
          description={t(
            '选择界面显示语言。更改后立即生效。也可从用户语言包目录加载自定义 JSON。',
          )}
          modified={language !== 'zh-CN'}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <select
            value={language}
            disabled={workspaceLocked}
            onChange={e => setLanguage(e.target.value)}
            className="setting-control setting-control-wide setting-select"
          >
            {localeOptions.map(option => (
              <option key={option.locale} value={option.locale}>
                {option.builtin ? t(option.label) : option.label}
              </option>
            ))}
          </select>
        </SettingItem>
      )}
      {match('自定义语言包', '语言包') && (
        <SettingItem
          title={t('自定义语言包')}
          description={t(
            '将 JSON 语言包放入应用数据目录的 locales 文件夹（可参考其中的 _example.json）。修改后点击刷新即可出现在上方列表。',
          )}
          locked={workspaceLocked}
          lockHint={t('此设置仅在用户作用域中可用')}
        >
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={workspaceLocked || !isTauri()}
              className="setting-control px-2.5 py-1 text-ui-sm"
              onClick={() => {
                void (async () => {
                  try {
                    const result = await reloadUserLocales()
                    pushToast(
                      'info',
                      t('已刷新语言包（{count} 个用户包）', {
                        count: result.loaded,
                      }),
                    )
                  } catch (error) {
                    pushToast('error', error instanceof Error ? error.message : String(error))
                  }
                })()
              }}
            >
              {t('刷新语言包')}
            </button>
            <button
              type="button"
              disabled={workspaceLocked || !isTauri()}
              className="setting-control px-2.5 py-1 text-ui-sm"
              onClick={() => {
                void (async () => {
                  try {
                    const dir = await safeInvoke<string>('读取语言包目录', 'user_locales_dir')
                    await revealItemInDir(dir)
                  } catch (error) {
                    pushToast('error', error instanceof Error ? error.message : String(error))
                  }
                })()
              }}
            >
              {t('打开语言包目录')}
            </button>
          </div>
        </SettingItem>
      )}
    </>
  )
}
