import { LoaderCircle } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { SettingItem } from '@/components/SettingsLayout'
import { getGitHead, getGitRemotes } from '@/lib/ipc/git'
import { getPushSyncTracking } from '@/lib/ipc/gitPushSync'
import { useI18n } from '@/lib/i18n'
import { listSshConnections } from '@/lib/projectRepository'
import { isProjectTrusted } from '@/lib/workspaceTrust'
import { useProjectStore } from '@/store/projectStore'
import type { Project } from '@/types'
import { allRemoteKeys, DEFAULT_CONFIG, type GitPushSyncConfig, type SyncAction } from './core'
import { machineConcurrency, syncMachineKey, type SyncResult } from './engine'
import { saveConfig } from './runtime'
import { type Inspection, readScanCache, scanCacheKey, writeScanCache } from './scanCache'
import { useGitPushSyncStore } from './store'

type Translate = ReturnType<typeof useI18n>['t']

/** 仓库分组的显示名：优先用 origin，其次第一个远程。 */
function inspect(remotes: Awaited<ReturnType<typeof getGitRemotes>>, branch: string | null): Inspection {
  const preferred = remotes.find(remote => remote.name === 'origin') ?? remotes[0]
  return { repo: preferred ? (allRemoteKeys([preferred])[0] ?? null) : null, branch }
}

/** 当前分支。SSH 项目的 getGitHead 会跑一次全量 status，改用只读引用的轻量查询。 */
async function readBranch(project: Project): Promise<string | null> {
  if (project.path.startsWith('ssh://')) return (await getPushSyncTracking(project.path)).branch
  return (await getGitHead(project.path))?.name ?? null
}

/**
 * 识别全部项目的仓库与分支。不同机器之间并行；同一台机器按 machineConcurrency 限制并发，
 * 避免在一条 SSH 连接上同时压太多 Git 命令。本地项目只读 HEAD 文件，不跑 Git status。
 */
async function scanProjects(
  targets: Project[],
  cached: Record<string, Inspection>,
  isCancelled: () => boolean,
  onProgress: () => void,
): Promise<Record<string, Inspection>> {
  const byMachine = new Map<string, Project[]>()
  for (const project of targets) {
    const machine = syncMachineKey(project)
    byMachine.set(machine, [...(byMachine.get(machine) ?? []), project])
  }
  const next: Record<string, Inspection> = {}
  const inspectOne = async (project: Project) => {
    try {
      const [remotes, branch] = await Promise.all([getGitRemotes(project.path), readBranch(project)])
      next[project.id] = inspect(remotes, branch)
    } catch {
      // 读取失败（多为远程未连接）时沿用上次结果，避免行在分组之间来回跳；
      // 从未识别过的才归入“未连接”分组。
      next[project.id] = cached[project.id] ?? { repo: null, branch: null }
    }
    onProgress()
  }
  await Promise.all(
    [...byMachine.entries()].flatMap(([machine, queue]) =>
      Array.from({ length: Math.min(machineConcurrency(machine), queue.length) }, async () => {
        for (let project = queue.shift(); project && !isCancelled(); project = queue.shift()) {
          await inspectOne(project)
        }
      }),
    ),
  )
  return next
}

function resultText(t: Translate, result: SyncResult | undefined): string {
  if (!result) return '—'
  const time = new Date(result.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
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
      let done = 0
      setScanning({ done, total: targets.length })
      // 结果全部读完后一次性提交，读取过程中不改动表格。
      const next = await scanProjects(
        targets,
        readScanCache(targets),
        () => cancelled,
        () => {
          done += 1
          if (!cancelled) setScanning({ done, total: targets.length })
        },
      )
      if (cancelled) return
      writeScanCache(targets, next)
      setInspections(next)
      setScanning(null)
    })()
    return () => {
      cancelled = true
      setScanning(null)
    }
  }, [signature, config.enabled])

  // 有项目从未识别过时，先显示加载状态，读取完成后再给出可操作的表格；
  // 全部都有上次结果时直接显示，后台刷新完成后整体替换一次。
  const ready = candidates.every(project => inspections[project.id] !== undefined)

  const groups = useMemo(() => {
    const grouped = new Map<string, Project[]>()
    for (const project of candidates) {
      const key = inspections[project.id]?.repo ?? ''
      grouped.set(key, [...(grouped.get(key) ?? []), project])
    }
    const rank = (key: string) => (key === '' ? 1 : 0)
    // 已识别仓库在前并按名称排序，未连接的放最后；同一仓库少于两个项目时也显示，方便确认识别结果。
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

  const groupTitle = (repo: string) => repo || t('未连接或没有远程仓库')

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
          {!ready ? (
            <div
              className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border border-border text-ui-sm text-fg-muted"
              role="status"
            >
              <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden />
              <span>{t('正在识别仓库 {done}/{total}', scanning ?? { done: 0, total: candidates.length })}</span>
              <span className="text-ui-xs">{t('读取完成后即可设置自动接收')}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* 固定高度的状态行：刷新提示出现或消失都不会推动下方表格。 */}
              <div className="flex h-4 items-center gap-1.5 text-ui-xs text-fg-muted" role="status">
                {scanning ? (
                  <>
                    <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    {t('正在刷新 {done}/{total}，完成后统一更新', scanning)}
                  </>
                ) : (
                  t('{count} 个项目', { count: candidates.length })
                )}
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                {/* 一张表：仓库作为分组行插在表内，共用一个表头；固定列宽，内容变化不会挤动列。 */}
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
                      <th className="font-normal px-3 py-1.5">{t('项目')}</th>
                      <th className="font-normal px-3 py-1.5">{t('位置')}</th>
                      <th className="font-normal px-3 py-1.5">{t('分支')}</th>
                      <th className="font-normal px-3 py-1.5">{t('推送检测')}</th>
                      <th className="font-normal px-3 py-1.5 text-center">{t('自动接收')}</th>
                      <th className="font-normal px-3 py-1.5">{t('最近结果')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map(([repo, members]) => (
                      <Fragment key={repo || 'unknown'}>
                        <tr className="border-t border-border bg-bg-elevated">
                          <th colSpan={6} scope="rowgroup" className="px-3 py-1.5 font-normal">
                            <div className="flex items-center gap-2">
                              <span
                                className={`min-w-0 flex-1 truncate text-ui-sm font-medium ${
                                  repo ? 'text-fg' : 'text-fg-muted'
                                }`}
                              >
                                {groupTitle(repo)}
                              </span>
                              <span className="shrink-0 text-ui-xs text-fg-muted">
                                {t('{count} 个项目', { count: members.length })}
                              </span>
                            </div>
                          </th>
                        </tr>
                        {members.map(project => {
                          const trusted = isProjectTrusted(project)
                          return (
                            <tr key={project.id} className="border-t border-border hover:bg-bg-hover">
                              <td className="pl-6 pr-3 py-1.5 text-fg truncate">{project.name}</td>
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
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SettingItem>
      )}
    </>
  )
}
