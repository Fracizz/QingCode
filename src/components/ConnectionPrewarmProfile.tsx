import { useEffect, useReducer } from 'react'
import { useI18n } from '../lib/i18n'
import { WORKSPACE_TRUST_CHANGED_EVENT } from '../lib/workspaceTrust'
import { isPrewarmCli } from '../lib/terminal/localCodexPrewarm'
import { connectionPrewarmProfile, saveConnectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { isTerminalProfileTrusted, TERMINAL_PROFILE_TRUST_CHANGED_EVENT } from '../lib/terminal/terminalProfileTrust'
import { loadTerminalProfileSettings } from '../lib/terminal/terminalProfiles'
import { SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import SettingSelect from './SettingSelect'
import { useProjectStore } from '../store/projectStore'
import { isWindowsSshRoot } from '../lib/sshWindowsRepair'
import { sshConnectionIdFromUri } from '../lib/sshWorkspace'

export default function ConnectionPrewarmProfile({ connectionId }: { connectionId: string }) {
  const { t } = useI18n()
  const [, refresh] = useReducer(n => n + 1, 0)
  useEffect(() => {
    const events = ['storage', WORKSPACE_TRUST_CHANGED_EVENT, SHELL_PREWARM_CHANGED_EVENT, TERMINAL_PROFILE_TRUST_CHANGED_EVENT]
    events.forEach(event => window.addEventListener(event, refresh))
    return () => events.forEach(event => window.removeEventListener(event, refresh))
  }, [])
  const profiles = loadTerminalProfileSettings().profiles.filter(p => isPrewarmCli(p.command))
  const selected = connectionPrewarmProfile(connectionId)
  // 由已注册项目的根路径判断远端系统；没有项目时不提示。
  const roots = useProjectStore(s => s.projects).map(p => p.path).filter(path => sshConnectionIdFromUri(path) === connectionId)
  const posixRemote = roots.length > 0 && !roots.some(isWindowsSshRoot)
  return <div className="space-y-2">
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
  </div>
}
