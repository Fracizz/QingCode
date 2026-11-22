import { useEffect, useReducer } from 'react'
import { useI18n } from '../lib/i18n'
import { WORKSPACE_TRUST_CHANGED_EVENT } from '../lib/workspaceTrust'
import { isPrewarmCli } from '../lib/terminal/localCodexPrewarm'
import {
  CONNECTION_PREWARM_MAX_COUNT, connectionPrewarmCount, connectionPrewarmProfile, saveConnectionPrewarmCount, saveConnectionPrewarmProfile,
} from '../lib/terminal/connectionPrewarmProfile'
import { isTerminalProfileTrusted, TERMINAL_PROFILE_TRUST_CHANGED_EVENT } from '../lib/terminal/terminalProfileTrust'
import { loadTerminalProfileSettings, profilesForConnection } from '../lib/terminal/terminalProfiles'
import { connectionPrewarmEnabled, setConnectionPrewarmEnabled, SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import SettingSelect from './SettingSelect'
import { useProjectStore } from '../store/projectStore'
import { isWindowsSshRoot } from '../lib/sshWindowsRepair'
import { sshConnectionIdFromUri } from '../lib/sshWorkspace'
import { cliPrewarmPauseDetail } from '../lib/terminal/cliPrewarmBlocked'
import { useCliPrewarmPause } from '../hooks/useCliPrewarmPause'

export default function ConnectionPrewarmProfile({ connectionId }: { connectionId: string }) {
  const { t } = useI18n()
  const [, refresh] = useReducer(n => n + 1, 0)
  useEffect(() => {
    const events = ['storage', WORKSPACE_TRUST_CHANGED_EVENT, SHELL_PREWARM_CHANGED_EVENT, TERMINAL_PROFILE_TRUST_CHANGED_EVENT]
    events.forEach(event => window.addEventListener(event, refresh))
    return () => events.forEach(event => window.removeEventListener(event, refresh))
  }, [])
  const profiles = profilesForConnection(loadTerminalProfileSettings(), connectionId).filter(p => isPrewarmCli(p.command))
  const enabled = connectionPrewarmEnabled(connectionId)
  const selected = connectionPrewarmProfile(connectionId)
  // 由已注册项目的根路径判断远端系统；没有项目时不提示。
  const roots = useProjectStore(s => s.projects).map(p => p.path).filter(path => sshConnectionIdFromUri(path) === connectionId)
  const posixRemote = roots.length > 0 && !roots.some(isWindowsSshRoot)
  const pause = cliPrewarmPauseDetail(useCliPrewarmPause(roots, enabled && !!selected), selected?.command ?? '')
  const toggle = <div className="space-y-2">
    <h3 className="text-ui font-semibold text-fg">{t('远端预热')}</h3>
    <p className="text-ui-sm text-fg-muted">{t('关闭后此连接不预热普通 Shell 和 CLI。本机预热在「设置 → 终端」中单独设置。')}</p>
    <div><SettingSelect menuZIndex={135} aria-label={t('远端预热')} value={enabled ? 'on' : 'off'}
      options={[{ value: 'on', label: t('开启') }, { value: 'off', label: t('关闭') }]}
      onChange={value => setConnectionPrewarmEnabled(connectionId, value === 'on')}
    /></div>
  </div>
  if (!enabled) return toggle
  return <div className="space-y-4">{toggle}<div className="space-y-2">
    <h3 className="text-ui font-semibold text-fg">{t('远端 CLI 预热')}</h3>
    <p className="text-ui-sm text-fg-muted">{t('为此连接提前启动所选 CLI，新建同配置终端时切换到受信任的目标项目。')}</p>
    {posixRemote && <p className="text-ui-sm text-fg">
      {t('Linux/macOS 远端的 CLI 本身启动较快，预热提速可能不明显。')}
    </p>}
    <div><SettingSelect menuZIndex={135} aria-label={t('远端 CLI 预热')} value={selected?.id ?? ''}
      options={[{ value: '', label: t('仅预热普通 Shell') }, ...profiles.map(p => ({
        value: p.id, label: p.name, disabled: !isTerminalProfileTrusted(p),
      }))]}
      onChange={id => saveConnectionPrewarmProfile(connectionId, profiles.find(p => p.id === id) ?? null)}
    /></div>
    {selected && <div className="space-y-1">
      <div className="text-ui-sm text-fg">{t('同时预热的 CLI 数量')}</div>
      <SettingSelect menuZIndex={135} aria-label={t('同时预热的 CLI 数量')} value={String(connectionPrewarmCount(connectionId))}
        options={Array.from({ length: CONNECTION_PREWARM_MAX_COUNT }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
        onChange={value => saveConnectionPrewarmCount(connectionId, Number(value))}
      />
      <p className="text-ui-sm text-fg-muted">{t('连续新建多个同配置终端时，每个都能领取已就绪的 CLI；每个预热的 CLI 都会占用远端内存。')}</p>
    </div>}
    {pause && <p role="status" className="text-ui-sm text-warn">{pause}</p>}
  </div></div>
}
