import { useEffect, useMemo, useState } from 'react'
import { SettingItem } from '@/components/SettingsLayout'
import { getGitRemotes, getGitStatus } from '@/lib/ipc/git'
import { useI18n } from '@/lib/i18n'
import { listSshConnections } from '@/lib/projectRepository'
import { isProjectTrusted } from '@/lib/workspaceTrust'
import { useProjectStore } from '@/store/projectStore'
import type { Project } from '@/types'
import { allRemoteKeys, DEFAULT_CONFIG, type GitPushSyncConfig, type SyncAction } from './core'
import type { SyncResult } from './engine'
import { saveConfig } from './runtime'
import { useGitPushSyncStore } from './store'

type Inspection = { repo: string | null; branch: string | null }
type Translate = ReturnType<typeof useI18n>['t']

/** 仓库分组的显示名：优先用 origin，其次第一个远程。 */
function inspect(remotes: Awaited<ReturnType<typeof getGitRemotes>>, branch: string | null): Inspection {
  const preferred = remotes.find(remote => remote.name === 'origin') ?? remotes[0]
  return { repo: preferred ? (allRemoteKeys([preferred])[0] ?? null) : null, branch }
}

function resultText(t: Translate, result: SyncResult | undefined): string {
  if (!result) return '—'
  const time = new Date(result.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const count = result.commits ?? 0
  switch (result.kind) {
    case 'synced':
      return t('已同步 {count} 个提交 · {time}', { count, time })
    case 'behind':
      return t('有 {count} 个新提交 · {time}', { count, time })
    case 'up-to-date':
      return t('已是最新 · {time}', { time })
    case 'ahead':
      return t('本地领先，无需同步')
    case 'diverged':
      return t('已跳过：与远端分叉')
    case 'no-upstream':
      return t('已跳过：没有上游分支')
    case 'dirty-editors':
      return t('已跳过：有未保存的文件')
    case 'blocked':
      return t('已跳过：Git 拒绝快进')
    case 'failed':
      return t('检查失败')
    case 'offline':
      return t('未连接，连接后补查')
  }
}

export default function GitPushSyncSection() {
  const { t } = useI18n()
  const projects = useProjectStore(state => state.projects)
  const pushToast = useProjectStore(state => state.pushToast)
  const config = useGitPushSyncStore(state => state.config)
  const detection = useGitPushSyncStore(state => state.detection)
  const results = useGitPushSyncStore(state => state.results)
  const [inspections, setInspections] = useState<Record<string, Inspection>>({})
  const [connectionNames, setConnectionNames] = useState<Record<string, string>>({})

  const candidates = useMemo(() => projects.filter(project => !project.ephemeral), [projects])

  useEffect(() => {
    if (!config.enabled) return
    let cancelled = false
    void listSshConnections()
      .then(rows => {
        if (!cancelled) setConnectionNames(Object.fromEntries(rows.map(row => [row.id, row.name])))
      })
      .catch(() => undefined)
    void (async () => {
      // 逐个读取：远程项目每次都是一次 SSH 往返，不并发压到同一条连接。
      for (const project of candidates) {
        if (cancelled) return
        try {
          const [remotes, status] = [
            await getGitRemotes(project.path),
            await getGitStatus(project.path),
          ]
          if (cancelled) return
          const inspection = inspect(remotes, status.branch ?? null)
          setInspections(previous => ({ ...previous, [project.id]: inspection }))
        } catch {
          // 未连接或不是仓库：保留在“未连接”分组。
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [candidates, config.enabled])

  const groups = useMemo(() => {
    const grouped = new Map<string, Project[]>()
    for (const project of candidates) {
      const key = inspections[project.id]?.repo ?? ''
      grouped.set(key, [...(grouped.get(key) ?? []), project])
    }
    // 已识别仓库在前；同一仓库少于两个项目时也显示，方便确认识别结果。
    return [...grouped.entries()].sort(([a], [b]) => (a && b ? a.localeCompare(b) : a ? -1 : 1))
  }, [candidates, inspections])

  const update = (next: GitPushSyncConfig) => {
    void saveConfig(next).catch(error =>
      pushToast('error', t('保存 Git 多端同步设置失败: {error}', { error: String(error) })),
    )
  }

  const toggleReceiver = (project: Project, checked: boolean) => {
    const receivers = checked
      ? [...config.receivers, project.id]
      : config.receivers.filter(id => id !== project.id)
    update({ ...config, receivers })
  }

  const detectionText = (project: Project) => {
    const state = detection[project.path]?.state
    if (state === 'live') return t('实时')
    if (state === 'waiting') return t('等待连接')
    if (state === 'panel-only' || project.kind === 'wsl') return t('仅面板推送')
    return '—'
  }

  const locationText = (project: Project) =>
    project.kind === 'ssh'
      ? (connectionNames[project.connection_id ?? ''] ?? t('远程'))
      : project.kind === 'wsl'
        ? 'WSL'
        : t('本机')

  return (
    <>
      <SettingItem
        title={t('启用推送后自动同步')}
        description={t(
          '在一个项目推送后，让同一仓库的其他项目立即获取更新。由推送事件触发，不做定时轮询；需要 QingCode 保持打开。',
        )}
        modified={config.enabled !== DEFAULT_CONFIG.enabled}
      >
        <select
          aria-label={t('启用推送后自动同步')}
          value={config.enabled ? 'on' : 'off'}
          onChange={event => update({ ...config, enabled: event.target.value === 'on' })}
          className="setting-control setting-select"
        >
          <option value="on">{t('开启')}</option>
          <option value="off">{t('关闭')}</option>
        </select>
      </SettingItem>
      <SettingItem
        title={t('收到更新后')}
        description={t(
          '自动快进只在本地没有分叉、没有未保存文件时执行，绝不自动合并、变基或贮藏；其他情况只提示。',
        )}
        modified={config.action !== DEFAULT_CONFIG.action}
      >
        <select
          aria-label={t('收到更新后')}
          value={config.action}
          disabled={!config.enabled}
          onChange={event => update({ ...config, action: event.target.value as SyncAction })}
          className="setting-control setting-select"
        >
          <option value="fast-forward">{t('自动快进')}</option>
          <option value="notify">{t('仅提示')}</option>
        </select>
      </SettingItem>
      {config.enabled && (
        <SettingItem
          title={t('项目')}
          description={t(
            '按远程地址自动归组。勾选“自动接收”的项目会跟随同组其他项目的推送。“仅面板推送”表示只能捕获 SCM 面板中的推送，终端里的推送要等窗口聚焦时补查。',
          )}
          layout="stacked"
        >
          <div className="flex flex-col gap-3 overflow-x-auto">
            {groups.map(([repo, members]) => (
              <div key={repo || 'unknown'}>
                <div className="text-ui-sm font-medium text-fg mb-1 break-all">
                  {repo || t('未连接或没有远程仓库')}
                </div>
                <table className="w-full text-ui-sm text-left">
                  <thead className="text-fg-muted">
                    <tr>
                      <th className="font-normal py-1 pr-3">{t('项目')}</th>
                      <th className="font-normal py-1 pr-3">{t('位置')}</th>
                      <th className="font-normal py-1 pr-3">{t('分支')}</th>
                      <th className="font-normal py-1 pr-3">{t('推送检测')}</th>
                      <th className="font-normal py-1 pr-3">{t('自动接收')}</th>
                      <th className="font-normal py-1">{t('最近结果')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(project => {
                      const trusted = isProjectTrusted(project)
                      return (
                        <tr key={project.id} className="border-t border-border">
                          <td className="py-1 pr-3 text-fg">{project.name}</td>
                          <td className="py-1 pr-3">{locationText(project)}</td>
                          <td className="py-1 pr-3">{inspections[project.id]?.branch ?? '—'}</td>
                          <td className="py-1 pr-3">{detectionText(project)}</td>
                          <td className="py-1 pr-3">
                            <input
                              type="checkbox"
                              aria-label={t('自动接收 {project}', { project: project.name })}
                              checked={config.receivers.includes(project.id)}
                              disabled={!trusted}
                              onChange={event => toggleReceiver(project, event.target.checked)}
                              className="accent-accent"
                            />
                          </td>
                          <td className="py-1">
                            {trusted ? resultText(t, results[project.path]) : t('项目未信任')}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </SettingItem>
      )}
    </>
  )
}
