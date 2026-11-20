import { useEffect, useReducer, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { WORKSPACE_TRUST_CHANGED_EVENT } from '../lib/workspaceTrust'
import { isPrewarmCli } from '../lib/terminal/localCodexPrewarm'
import { sshRemoteDisplayPath, sshRemotePathFromUri } from '../lib/sshWorkspace'
import { cliDisplayName, cliHasDirectoryTrust, loadCliTrust, prewarmCliAgent, type CliTrustResult } from '../lib/terminal/cliTrust'
import {
  connectionPrewarmCandidates, connectionPrewarmOptions, connectionPrewarmProfile, resolveConnectionPrewarmAnchor, saveConnectionPrewarmProfile,
} from '../lib/terminal/connectionPrewarmProfile'
import { isTerminalProfileTrusted, TERMINAL_PROFILE_TRUST_CHANGED_EVENT } from '../lib/terminal/terminalProfileTrust'
import { loadTerminalProfileSettings } from '../lib/terminal/terminalProfiles'
import { SHELL_PREWARM_CHANGED_EVENT } from '../lib/terminal/shellPrewarmSettings'
import SettingSelect from './SettingSelect'
import SettingSwitch from './SettingSwitch'

type TrustState = { key: string; reload: number; result: CliTrustResult }

export default function ConnectionPrewarmProfile({ connectionId }: { connectionId: string }) {
  const projects = useProjectStore(s => s.projects)
  const { t } = useI18n()
  const [, refresh] = useReducer(n => n + 1, 0)
  const [trust, setTrust] = useState<TrustState>()
  const [reload, forceReload] = useReducer(n => n + 1, 0)
  useEffect(() => {
    const events = ['storage', WORKSPACE_TRUST_CHANGED_EVENT, SHELL_PREWARM_CHANGED_EVENT, TERMINAL_PROFILE_TRUST_CHANGED_EVENT]
    events.forEach(event => window.addEventListener(event, refresh))
    return () => events.forEach(event => window.removeEventListener(event, refresh))
  }, [])
  const profiles = loadTerminalProfileSettings().profiles.filter(p => isPrewarmCli(p.command))
  const selected = connectionPrewarmProfile(connectionId)
  const options = connectionPrewarmOptions(connectionId)
  const agent = selected && prewarmCliAgent(selected.command)
  const needsTrust = cliHasDirectoryTrust(agent)
  const readCli = needsTrust && !!options.readCliConfig
  const candidates = connectionPrewarmCandidates(projects, connectionId)
  const candidatePaths = candidates.map(p => p.path)
  const candidateKey = `${connectionId}\n${agent}\n${candidatePaths.join('\n')}`

  // 用户开启后才读取；打开面板或点「重新读取」时强制刷新，后台预热沿用缓存。
  useEffect(() => {
    if (!readCli || !cliHasDirectoryTrust(agent) || !candidatePaths.length) return
    let cancelled = false
    void loadCliTrust(connectionId, agent, candidatePaths, true).then(result => {
      if (!cancelled) setTrust({ key: candidateKey, reload, result })
    })
    return () => { cancelled = true }
    // candidateKey 已涵盖连接、CLI 与候选项目
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readCli, candidateKey, reload])

  // 重新读取期间保留上次结果，避免下拉闪回「未选择」。
  const shown = trust?.key === candidateKey ? trust : undefined
  const loading = readCli && candidates.length > 0 && shown?.reload !== reload
  const current = shown && { loading, result: shown.result }
  const cliTrusted = readCli ? current?.result?.roots : undefined
  const anchor = resolveConnectionPrewarmAnchor(connectionId, candidates, { cliTrusted })
  const cliSet = new Set(cliTrusted ?? [])
  const display = (path: string) => sshRemoteDisplayPath(sshRemotePathFromUri(path))
  const fixed = anchor?.source === 'fixed' ? anchor.path : ''
  const name = agent ? cliDisplayName(agent) : ''
  const save = (next: { anchor?: string; readCliConfig?: boolean }) =>
    saveConnectionPrewarmProfile(connectionId, selected ?? null, { ...options, ...next })

  const autoLabel = anchor && anchor.source !== 'fixed'
    ? `${t('自动')} · ${display(anchor.path)}`
    : needsTrust ? t('未选择（仅当前项目）') : t('自动')
  const hint = (() => {
    if (!needsTrust || anchor) return
    if (!readCli) return t('{name} 需要启动目录已被它信任，否则预热会停在信任确认。请手动选择，或开启读取配置自动选择。', { name })
    if (!candidates.length) return t('此连接没有已信任的项目。')
    if (!current || loading) return
    const result = current.result
    if (result?.error) return t('读取 {name} 配置失败：{error}。请手动选择已在 {name} 中确认信任的项目。', { name, error: result.error })
    if (!result?.configFound) return t('远端没有 {name} 配置文件。请先在终端里打开一次 {name} 并确认信任目录，或手动选择。', { name })
    return t('{name} 尚未信任此连接上的任何已信任项目。请手动选择，或先在终端里打开 {name} 确认信任。', { name })
  })()
  const fixedUntrusted = anchor?.source === 'fixed' && cliTrusted && !cliSet.has(anchor.path)
  const readNote = agent === 'claude'
    ? t('开启即授权只读读取远端 ~/.claude.json（或 $CLAUDE_CONFIG_DIR），只用于匹配已信任项目，内容不保存。')
    : t('开启即授权只读读取远端 ~/.codex/config.toml（或 $CODEX_HOME），只用于匹配已信任项目，内容不保存。')

  return <div className="space-y-2">
    <h3 className="text-ui font-semibold text-fg">{t('远端 CLI 预热')}</h3>
    <p className="text-ui-sm text-fg-muted">{t('为此连接提前启动所选 CLI，新建同配置终端时切换到受信任的目标项目。')}</p>
    <div><SettingSelect menuZIndex={135} aria-label={t('远端 CLI 预热')} value={selected?.id ?? ''}
      options={[{ value: '', label: t('仅预热普通 Shell') }, ...profiles.map(p => ({
        value: p.id, label: p.name, disabled: !isTerminalProfileTrusted(p),
      }))]}
      onChange={id => saveConnectionPrewarmProfile(connectionId, profiles.find(p => p.id === id) ?? null, options)}
    /></div>
    {selected && <div className="space-y-2 pt-1">
      {needsTrust && <div className="space-y-1">
        <SettingSwitch className="text-ui-sm text-fg" checked={readCli} onChange={readCliConfig => save({ readCliConfig })}
          label={t('读取 {name} 信任配置自动选择目录', { name })} />
        <p className="text-ui-xs text-fg-muted">{readNote}</p>
      </div>}
      {agent === 'opencode' && <p className="text-ui-xs text-fg-muted">{t('OpenCode 没有目录信任，自动使用当前或最近打开的已信任项目。')}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="text-ui-sm text-fg-muted">{t('CLI 启动目录')}</label>
        <SettingSelect aria-label={t('CLI 启动目录')} menuZIndex={135} value={fixed}
          options={[
            { value: '', label: autoLabel },
            ...candidates.map(p => ({
              value: p.path,
              label: cliSet.has(p.path) ? `${display(p.path)} · ${t('{name} 已信任', { name })}` : display(p.path),
            })),
          ]}
          onChange={cwd => save({ anchor: cwd || undefined })} />
        {readCli && candidates.length > 0 && <button type="button" className="text-ui-sm text-accent hover:underline disabled:opacity-50"
          disabled={loading} onClick={forceReload}>
          {loading ? t('读取中…') : t('重新读取')}
        </button>}
      </div>
      {hint && <p role="status" className="text-ui-xs text-warn">{hint}</p>}
      {fixedUntrusted && <p role="status" className="text-ui-xs text-warn">
        {t('所选目录未在 {name} 中信任，预热会停在信任确认。', { name })}
      </p>}
    </div>}
  </div>
}
