import { useI18n } from '../../lib/i18n'
import { DEFAULT_SHORTCUTS, type ShortcutCommand } from '../../lib/shortcuts'
import { useShortcutStore } from '../../store/shortcutStore'
import { SettingItem } from '../SettingsLayout'
import ShortcutSettings from '../ShortcutSettings'

/** 快捷键分区：修改标记 + 快捷键列表（列表按小写查询词自行过滤）。 */
export default function ShortcutsSettingsSection({ query }: { query: string }) {
  const { t } = useI18n()
  const shortcuts = useShortcutStore(s => s.shortcuts)

  return (
    <>
      <SettingItem
        title={t('键盘快捷方式')}
        description={t('自定义常用操作的按键组合。')}
        modified={Object.keys(DEFAULT_SHORTCUTS).some(
          key => shortcuts[key as ShortcutCommand] !== DEFAULT_SHORTCUTS[key as ShortcutCommand],
        )}
      >
        <span className="text-ui-sm text-fg-dim">{t('见下方列表')}</span>
      </SettingItem>
      <div className="pl-3">
        <ShortcutSettings query={query} />
      </div>
    </>
  )
}
