import { useEffect, useReducer } from 'react'
import { useI18n } from '../lib/i18n'
import {
  CONNECTION_DEFAULT_PROFILE_CHANGED_EVENT,
  connectionDefaultProfileId,
  globalDefaultProfileIdFor,
  saveConnectionDefaultProfileId,
} from '../lib/terminal/connectionDefaultProfile'
import { DEFAULT_TERMINAL_PROFILE, loadTerminalProfileSettings, profilesForConnection } from '../lib/terminal/terminalProfiles'
import { SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import SettingSelect from './SettingSelect'

export default function ConnectionDefaultProfile({ connectionId }: { connectionId: string }) {
  const { t } = useI18n()
  const [, refresh] = useReducer(n => n + 1, 0)
  useEffect(() => {
    // 配置增删（SHELL_PREWARM_CHANGED_EVENT 随保存触发）与本设置变化都要刷新。
    const events = ['storage', SHELL_PREWARM_CHANGED_EVENT, CONNECTION_DEFAULT_PROFILE_CHANGED_EVENT]
    events.forEach(event => window.addEventListener(event, refresh))
    return () => events.forEach(event => window.removeEventListener(event, refresh))
  }, [])
  const settings = loadTerminalProfileSettings()
  const nameOf = (id: string) => {
    const profile = settings.profiles.find(p => p.id === id)
    if (!profile || profile.id === DEFAULT_TERMINAL_PROFILE.id) return t('普通终端')
    return profile.name.trim() || t('未命名配置')
  }
  return <div className="space-y-2">
    <h3 className="text-ui font-semibold text-fg">{t('默认终端配置')}</h3>
    <p className="text-ui-sm text-fg-muted">{t('在此连接的远程项目中点击「+」新建终端时使用的配置。')}</p>
    <SettingSelect menuZIndex={135} aria-label={t('默认终端配置')}
      value={connectionDefaultProfileId(connectionId, settings) ?? ''}
      options={[
        { value: '', label: t('跟随全局默认（{name}）', { name: nameOf(globalDefaultProfileIdFor(connectionId, settings)) }) },
        ...profilesForConnection(settings, connectionId).map(p => ({ value: p.id, label: nameOf(p.id) })),
      ]}
      onChange={id => saveConnectionDefaultProfileId(connectionId, id || null)}
    />
  </div>
}
