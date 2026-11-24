import { useEffect, useReducer } from 'react'
import { useI18n } from '../lib/i18n'
import { WORKSPACE_TRUST_CHANGED_EVENT } from '../lib/workspaceTrust'
import { isPrewarmCli } from '../lib/terminal/localCodexPrewarm'
import {
  CONNECTION_PREWARM_MAX_COUNT, connectionPrewarmCount, connectionPrewarmProfile, saveConnectionPrewarmCount, saveConnectionPrewarmProfile,
} from '../lib/terminal/connectionPrewarmProfile'
import { isTerminalProfileTrusted, TERMINAL_PROFILE_TRUST_CHANGED_EVENT } from '../lib/terminal/terminalProfileTrust'
import { loadTerminalProfileSettings, profilesForConnection } from '../lib/terminal/terminalProfiles'
import {
  connectionPrewarmEnabled, connectionShellPrewarmCount, setConnectionPrewarmEnabled, setConnectionShellPrewarmCount,
  SHELL_PREWARM_CHANGED_EVENT,
} from '../lib/terminal/shellPrewarmSettings'
import SettingSelect from './SettingSelect'
import ConnectionSettingRow from './ConnectionSettingRow'
import { useProjectStore } from '../store/projectStore'
import { isWindowsSshRoot } from '../lib/sshWindowsRepair'
import { sshConnectionIdFromUri } from '../lib/sshWorkspace'
import { cliPrewarmPauseDetail } from '../lib/terminal/cliPrewarmBlocked'
import { useCliPrewarmPause } from '../hooks/useCliPrewarmPause'
import { usePrewarmStatuses } from '../hooks/usePrewarmStatuses'
import type { PrewarmPoolStatus } from '../lib/terminal/prewarmBadge'

const SHELL_COUNT_MAX = 8

/**
 * 「远程连接 → 终端」中的预热设置：本连接的总开关、普通 Shell 数量、CLI 及其数量，
 * 并显示两个池的实时就绪情况。普通 Shell 与 CLI 是两个独立的池，各自按数量补充。
 */
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
  const shellCount = connectionShellPrewarmCount(connectionId)
  const selected = connectionPrewarmProfile(connectionId)
  // 由已注册项目的根路径判断远端系统；没有项目时不提示。
  const projects = useProjectStore(s => s.projects).filter(p => sshConnectionIdFromUri(p.path) === connectionId)
  const roots = projects.map(p => p.path)
  const posixRemote = roots.length > 0 && !roots.some(isWindowsSshRoot)
  const pause = cliPrewarmPauseDetail(useCliPrewarmPause(roots, enabled && !!selected), selected?.command ?? '')
  const recent = [...projects].sort((a, b) => b.last_opened_at - a.last_opened_at).slice(0, 3)
  const live = usePrewarmStatuses(enabled ? [{ key: connectionId, projects: recent }] : []).get(connectionId)?.status
  const poolText = (label: string, pool?: PrewarmPoolStatus) =>
    pool?.target ? `${label} ${pool.ready ?? 0}/${pool.target}` : null
  const liveText = live && [poolText('Shell', live), poolText('CLI', live.profile)].filter(Boolean).join(' · ')

  return <div aria-label={t('终端预热')} className="divide-y divide-dialog-separator">
    <ConnectionSettingRow
      title={<span className="flex items-center gap-2">{t('远端预热')}
        {liveText && <span className="rounded bg-dialog-active px-1.5 py-0.5 font-mono text-ui-xs text-fg-muted">{t('就绪 {summary}', { summary: liveText })}</span>}
      </span>}
      description={t('提前在此连接上准备空闲终端，新建时直接领取并切到目标项目。需 Server 模式且有受信任项目；关闭后此连接不预热普通 Shell 和 CLI，其他连接与本机不受影响。')}
    >
      <SettingSelect menuZIndex={135} className="setting-control-wide" aria-label={t('远端预热')} value={enabled ? 'on' : 'off'}
        options={[{ value: 'on', label: t('开启') }, { value: 'off', label: t('关闭') }]}
        onChange={value => setConnectionPrewarmEnabled(connectionId, value === 'on')}
      />
    </ConnectionSettingRow>
    {enabled && <>
      <ConnectionSettingRow
        title={t('普通 Shell 预热数量')}
        description={t('Windows 远端为 PowerShell / CMD，Linux / macOS 远端为 bash / zsh / sh 或登录 Shell。自动保留 1 个，领取后立即补充；多设几个只在连续快速新建时有用。')}
      >
        <SettingSelect menuZIndex={135} className="setting-control-wide" aria-label={t('普通 Shell 预热数量')} value={String(shellCount)}
          options={[
            { value: 'auto', label: t('自动（1 个）') },
            { value: '0', label: t('不预热') },
            ...Array.from({ length: SHELL_COUNT_MAX }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
          ]}
          onChange={value => setConnectionShellPrewarmCount(connectionId, value === 'auto' ? 'auto' : Number(value))}
        />
      </ConnectionSettingRow>
      <ConnectionSettingRow
        title={t('远端 CLI 预热')}
        description={t('另外提前启动所选 CLI，新建同配置终端时切换到受信任的目标项目。与普通 Shell 是两个独立的池，各按自己的数量补充。')}
        footer={<>
          {posixRemote && <p className="mt-1.5 text-ui-sm text-fg">{t('Linux/macOS 远端的 CLI 本身启动较快，预热提速可能不明显。')}</p>}
          {pause && <p role="status" className="mt-1.5 text-ui-sm text-warn">{pause}</p>}
        </>}
      >
        <SettingSelect menuZIndex={135} className="setting-control-wide" aria-label={t('远端 CLI 预热')} value={selected?.id ?? ''}
          options={[{ value: '', label: t('不预热 CLI') }, ...profiles.map(p => ({
            value: p.id, label: p.name, disabled: !isTerminalProfileTrusted(p),
          }))]}
          onChange={id => saveConnectionPrewarmProfile(connectionId, profiles.find(p => p.id === id) ?? null)}
        />
      </ConnectionSettingRow>
      {selected && <ConnectionSettingRow
        title={t('同时预热的 CLI 数量')}
        description={t('连续新建多个同配置终端时，每个都能领取已就绪的 CLI；每个预热的 CLI 都会占用远端内存。')}
      >
        <SettingSelect menuZIndex={135} className="setting-control-wide" aria-label={t('同时预热的 CLI 数量')} value={String(connectionPrewarmCount(connectionId))}
          options={Array.from({ length: CONNECTION_PREWARM_MAX_COUNT }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
          onChange={value => saveConnectionPrewarmCount(connectionId, Number(value))}
        />
      </ConnectionSettingRow>}
    </>}
  </div>
}
