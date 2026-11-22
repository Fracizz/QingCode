import { useEffect, useReducer } from 'react'
import { useI18n } from '../../lib/i18n'
import { localCodexPrewarm, saveLocalCodexPrewarm, supportsCodexPrewarm } from '../../lib/terminal/localCodexPrewarm'
import { isTerminalProfileTrusted, TERMINAL_PROFILE_TRUST_CHANGED_EVENT } from '../../lib/terminal/terminalProfileTrust'
import { localPrewarmEnabled, setLocalPrewarmEnabled, SHELL_PREWARM_CHANGED_EVENT } from '../../lib/terminal/shellPrewarmSettings'
import type { TerminalProfile } from '../../lib/terminal/terminalProfiles'
import SettingSelect from '../SettingSelect'
import { SettingItem } from '../SettingsLayout'
import { cliPrewarmPauseDetail } from '../../lib/terminal/cliPrewarmBlocked'
import { useCliPrewarmPause } from '../../hooks/useCliPrewarmPause'
import { useProjectStore } from '../../store/projectStore'
import { isProjectTrusted } from '../../lib/workspaceTrust'

function usePrewarmRefresh() {
  const [, refresh] = useReducer(n => n + 1, 0)
  useEffect(() => {
    const events = ['storage', SHELL_PREWARM_CHANGED_EVENT, TERMINAL_PROFILE_TRUST_CHANGED_EVENT]
    events.forEach(e => window.addEventListener(e, refresh))
    return () => events.forEach(e => window.removeEventListener(e, refresh))
  }, [])
}

/** 本机预热总开关：只管本机池（普通 Shell 和本机 CLI），远程连接在「远程连接」中各自设置。 */
export function LocalPrewarmToggle() {
  const { t } = useI18n()
  usePrewarmRefresh()
  const enabled = localPrewarmEnabled()
  return <SettingItem title={t('终端 › 集成: 本机预热')} modified={!enabled}
    description={t('关闭后本机不预热普通 Shell 和 CLI，远程连接不受影响；各远程连接在「远程连接」中单独设置。')}>
    <SettingSelect aria-label={t('终端 › 集成: 本机预热')} value={enabled ? 'on' : 'off'}
      options={[{ value: 'on', label: t('开启') }, { value: 'off', label: t('关闭') }]}
      onChange={value => setLocalPrewarmEnabled(value === 'on')} />
  </SettingItem>
}

export default function LocalCodexPrewarm({ profiles }: { profiles: TerminalProfile[] }) {
  const { t } = useI18n()
  usePrewarmRefresh()
  const enabled = localPrewarmEnabled()
  const saved = localCodexPrewarm()
  // 本机 CLI 预热不绑定项目，用任一已信任的本机项目查询状态。
  const projects = useProjectStore(s => s.projects)
  const localRoots = projects.filter(p => !p.path.startsWith('ssh://') && isProjectTrusted(p)).slice(0, 3).map(p => p.path)
  const pause = cliPrewarmPauseDetail(useCliPrewarmPause(localRoots, enabled && !!saved), saved?.command ?? '')
  if (!enabled) return null
  return <SettingItem title={t('本机 CLI 预热')} modified={!!saved}
    description={t('选择运行 claude、opencode、codex 或 pi 的已信任 PowerShell 配置。QingCode 在专用目录提前启动所选工具，新建终端时切换到目标项目。')}>
    <SettingSelect aria-label={t('CLI 预热配置')} value={saved?.id ?? ''}
      options={[{ value: '', label: t('关闭') }, ...profiles.filter(supportsCodexPrewarm).map(p =>
        ({ value: p.id, label: p.name, disabled: !isTerminalProfileTrusted(p) }))]}
      onChange={id => saveLocalCodexPrewarm(profiles.find(p => p.id === id))} />
    {pause && <p role="status" className="mt-1.5 text-ui-sm text-warn">{pause}</p>}
  </SettingItem>
}
