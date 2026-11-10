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
import { type Inspection, readScanCache, scanCacheKey, writeScanCache } from './scanCache'
import { useGitPushSyncStore } from './store'

type Translate = ReturnType<typeof useI18n>['t']

/** 尚未识别完成的项目所在分组的内部键（不会与真实远程地址冲突）。 */
const PENDING = '<pending>'

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

  const candidates = useMemo(() => projects.filter(project => !project.ephemeral), [projects])
  // 只在项目增删或路径变化时重扫；最近打开时间等字段变化不触发。
  const signature = candidates.map(scanCacheKey).join('\n')
  const [inspections, setInspections] = useState<Record<string, Inspection>>(() =>
    readScanCache(candidates),
  )
  const [scanning, setScanning] = useState<{ done: number; total: number } | null>(null)
  const [connectionNames, setConnectionNames] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!config.enabled) return
    let cancelled = false
    const targets = useProjectStore.getState().projects.filter(project => !project.ephemeral)
    void listSshConnections()
      .then(rows => {
        if (!cancelled) setConnectionNames(Object.fromEntries(rows.map(row => [row.id, row.name])))
      })
      .catch(() => undefined)
    void (async () => {
      // 结果先攒在本地，全部完成后一次性提交，避免行在分组之间逐个跳动。
      const next: Record<string, Inspection> = {}
      setScanning({ done: 0, total: targets.length })
      // 逐个读取：远程项目每次都是一次 SSH 往返，不并发压到同一条连接。
      for (const [index, project] of targets.entries()) {
        if (cancelled) return
        try {
          const remotes = await getGitRemotes(project.path)
          const status = await getGitStatus(project.path)
          next[project.id] = inspect(remotes, status.branch ?? null)
        } catch {
          // 未连接或不是仓库：归入“未连接”分组。
          next[project.id] = { repo: null, branch: null }
        }
        if (cancelled) return
        setScanning({ done: index + 1, total: targets.length })
      }
      writeScanCache(targets, next)
      setInspections(next)
      setScanning(null)
    })()
    return () => {
      cancelled = true
      setScanning(null)
    }
  }, [signature, config.enabled])

  const groups = useMemo(() => {
    const grouped = new Map<string, Project[]>()
    for (const project of candidates) {
      const entry = inspections[project.id]
      // 首次扫描中尚未识别的项目单独成组，扫描结束后再统一归组。
      const key = entry === undefined ? PENDING : (entry.repo ?? '')
      grouped.set(key, [...(grouped.get(key) ?? []), project])
    }
    const rank = (key: string) => (key === PENDING ? 2 : key === '' ? 1 : 0)
    // 已识别仓库在前并按名称排序；同一仓库少于两个项目时也显示，方便确认识别结果。
    return [...grouped.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
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

  const groupTitle = (repo: string) =>
    repo === PENDING ? t('正在识别仓库…') : repo || t('未连接或没有远程仓库')

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
          <div className="flex flex-col gap-3">
            {scanning && (
              <div className="text-ui-xs text-fg-muted" role="status">
                {t('正在识别仓库 {done}/{total}', scanning)}
              </div>
            )}
            {groups.map(([repo, members]) => (
              <section key={repo || 'unknown'} className="rounded-md border border-border overflow-hidden">
                <header className="flex items-center gap-2 px-3 py-1.5 bg-bg-elevated border-b border-border">
                  <span
                    className={`min-w-0 flex-1 truncate text-ui-sm font-medium ${
                      repo && repo !== PENDING ? 'text-fg' : 'text-fg-muted'
                    }`}
                  >
                    {groupTitle(repo)}
                  </span>
                  <span className="shrink-0 text-ui-xs text-fg-muted">
                    {t('{count} 个项目', { count: members.length })}
                  </span>
                </header>
                <div className="overflow-x-auto">
                  {/* 固定列宽：各分组的列对齐，内容长短变化也不会挤动列位置。 */}
                  <table className="w-full min-w-[560px] table-fixed text-ui-sm text-left">
                    <colgroup>
                      <col />
                      <col className="w-[16%]" />
                      <col className="w-[13%]" />
                      <col className="w-[14%]" />
                      <col className="w-[10%]" />
                      <col className="w-[24%]" />
                    </colgroup>
                    <thead className="text-fg-muted">
                      <tr>
                        <th className="font-normal px-3 py-1">{t('项目')}</th>
                        <th className="font-normal px-3 py-1">{t('位置')}</th>
                        <th className="font-normal px-3 py-1">{t('分支')}</th>
                        <th className="font-normal px-3 py-1">{t('推送检测')}</th>
                        <th className="font-normal px-3 py-1 text-center">{t('自动接收')}</th>
                        <th className="font-normal px-3 py-1">{t('最近结果')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map(project => {
                        const trusted = isProjectTrusted(project)
                        return (
                          <tr key={project.id} className="border-t border-border hover:bg-bg-hover">
                            <td className="px-3 py-1.5 text-fg truncate">{project.name}</td>
                            <td className="px-3 py-1.5 text-fg-muted truncate">{locationText(project)}</td>
                            <td className="px-3 py-1.5 truncate">{inspections[project.id]?.branch ?? '—'}</td>
                            <td className="px-3 py-1.5 text-fg-muted truncate">{detectionText(project)}</td>
                            <td className="px-3 py-1.5 text-center">
                              <input
                                type="checkbox"
                                aria-label={t('自动接收 {project}', { project: project.name })}
                                checked={config.receivers.includes(project.id)}
                                disabled={!trusted}
                                onChange={event => toggleReceiver(project, event.target.checked)}
                                className="accent-accent align-middle"
                              />
                            </td>
                            <td className="px-3 py-1.5 text-fg-muted truncate">
                              {trusted ? resultText(t, results[project.path]) : t('项目未信任')}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        </SettingItem>
      )}
    </>
  )
}
