import { useEffect, useReducer } from 'react'
import { useI18n } from '../../lib/i18n'
import { localCodexPrewarm, saveLocalCodexPrewarm, supportsCodexPrewarm } from '../../lib/terminal/localCodexPrewarm'
import { isTerminalProfileTrusted, TERMINAL_PROFILE_TRUST_CHANGED_EVENT } from '../../lib/terminal/terminalProfileTrust'
import { SHELL_PREWARM_CHANGED_EVENT } from '../../lib/terminal/shellPrewarmSettings'
import type { TerminalProfile } from '../../lib/terminal/terminalProfiles'
import SettingSelect from '../SettingSelect'
import { SettingItem } from '../SettingsLayout'

export default function LocalCodexPrewarm({ profiles }: { profiles: TerminalProfile[] }) {
  const { t } = useI18n()
  const [, refresh] = useReducer(n => n + 1, 0)
  useEffect(() => {
    const events = ['storage', SHELL_PREWARM_CHANGED_EVENT, TERMINAL_PROFILE_TRUST_CHANGED_EVENT]
    events.forEach(e => window.addEventListener(e, refresh))
    return () => events.forEach(e => window.removeEventListener(e, refresh))
  }, [])
  const saved = localCodexPrewarm()
  return <SettingItem title={t('本机 CLI 预热')} modified={!!saved}
    description={t('选择运行 claude、opencode 或 codex 的已信任 PowerShell 配置。QingCode 在专用目录提前启动所选工具，新建终端时切换到目标项目。')}>
    <SettingSelect aria-label={t('CLI 预热配置')} value={saved?.id ?? ''}
      options={[{ value: '', label: t('关闭') }, ...profiles.filter(supportsCodexPrewarm).map(p =>
        ({ value: p.id, label: p.name, disabled: !isTerminalProfileTrusted(p) }))]}
      onChange={id => saveLocalCodexPrewarm(profiles.find(p => p.id === id))} />
  </SettingItem>
}
