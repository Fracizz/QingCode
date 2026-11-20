import { useEffect, useReducer } from 'react'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { isProjectTrusted, WORKSPACE_TRUST_CHANGED_EVENT } from '../lib/workspaceTrust'
import { isPrewarmCli } from '../lib/terminal/localCodexPrewarm'
import { sshRemoteDisplayPath, sshRemotePathFromUri, sshConnectionIdFromUri } from '../lib/sshWorkspace'
import { connectionPrewarmAnchors, connectionPrewarmProfile, saveConnectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { isTerminalProfileTrusted, TERMINAL_PROFILE_TRUST_CHANGED_EVENT } from '../lib/terminal/terminalProfileTrust'
import { loadTerminalProfileSettings } from '../lib/terminal/terminalProfiles'
import { SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import SettingSelect from './SettingSelect'

export default function ConnectionPrewarmProfile({ connectionId }: { connectionId: string }) {
  const projects = useProjectStore(s => s.projects)
  const { t } = useI18n()
  const [, refresh] = useReducer(n => n + 1, 0)
  useEffect(() => {
    const events = ['storage', WORKSPACE_TRUST_CHANGED_EVENT, SHELL_PREWARM_CHANGED_EVENT, TERMINAL_PROFILE_TRUST_CHANGED_EVENT]
    events.forEach(event => window.addEventListener(event, refresh))
    return () => events.forEach(event => window.removeEventListener(event, refresh))
  }, [])
  const profiles = loadTerminalProfileSettings().profiles.filter(p => p.command.trim())
  const selected = connectionPrewarmProfile(connectionId)
  const currentAnchor = connectionPrewarmAnchors().find(p => sshConnectionIdFromUri(p.cwd) === connectionId)
  const roots = projects.filter(p => sshConnectionIdFromUri(p.path) === connectionId && !p.ephemeral && isProjectTrusted(p))
  return <div className="space-y-2">
    <h3 className="text-ui font-semibold text-fg">{t('预热终端配置')}</h3>
    <p className="text-ui-sm text-fg-muted">{t('打开此连接的受信任 Windows 项目时，在项目目录后台运行一个所选配置。新建同配置终端时接入并补充。需开启 Shell 预热；首次使用请先在终端中信任该配置。')}</p>
    <SettingSelect menuZIndex={135} aria-label={t('预热终端配置')} value={selected?.id ?? ''}
      options={[{ value: '', label: t('仅预热普通 Shell') }, ...profiles.map(p => ({
        value: p.id, label: p.name, disabled: !isTerminalProfileTrusted(p),
      }))]}
      onChange={id => saveConnectionPrewarmProfile(connectionId, profiles.find(p => p.id === id) ?? null)}
    />
    {selected && isPrewarmCli(selected.command) && <>
      <label className="text-ui-sm text-fg">{t('跨项目 CLI 启动目录')}</label>
      <SettingSelect aria-label={t('跨项目 CLI 启动目录')} menuZIndex={135}
        value={roots.some(p => p.path === currentAnchor?.cwd) ? currentAnchor?.cwd ?? '' : ''}
        options={[{ value: '', label: t('使用当前项目') }, ...roots.map(p => ({ value: p.path, label: sshRemoteDisplayPath(sshRemotePathFromUri(p.path)) }))]}
        onChange={cwd => saveConnectionPrewarmProfile(connectionId, selected, cwd || undefined)} />
    </>}
  </div>
}
