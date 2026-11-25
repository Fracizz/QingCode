import { Keyboard } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import { useTerminalShortcutBarStore } from '../store/terminalShortcutBarStore'

/** 设置 → 终端 → 快捷键栏：显示开关 + 打开管理弹窗（TerminalShortcutBarManager）。 */
export default function TerminalShortcutBarSettings() {
  const { t } = useI18n()
  const collapsed = useTerminalShortcutBarStore(s => s.collapsed)
  const setCollapsed = useTerminalShortcutBarStore(s => s.setCollapsed)
  const openManager = useTerminalShortcutBarStore(s => s.openManager)
  const count = useTerminalShortcutBarStore(s => s.order.length)
  return (
    <div className="terminal-profiles min-w-0" data-settings-anchor="terminal-shortcut-bar" aria-label={t('快捷键栏')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-ui font-medium">{t('快捷键栏')}</h3>
          <label className="flex items-center gap-1.5 text-ui-sm text-fg-muted">
            <input type="checkbox" checked={!collapsed} onChange={event => setCollapsed(!event.target.checked)} />
            {t('在终端底部显示')}
          </label>
        </div>
        <button type="button" className="terminal-profile-add" onClick={openManager}>
          <Keyboard size={14} />{t('管理快捷键栏…')}
        </button>
      </div>
      <p className="mt-1.5 text-ui-sm leading-relaxed text-fg-muted">
        {t('终端底部的一排自定义键，点击把设定的文本发送到所在终端；当前 {n} 个键。可添加、排序、隐藏或删除。', { n: count })}
      </p>
    </div>
  )
}
