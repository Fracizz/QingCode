import { useEffect, useState } from 'react'
import { RotateCw, Trash2 } from 'lucide-react'
import { t } from '@qn/codex-client'
import type { RgPluginInfo, RgPluginStatus } from '@qn/protocol'
import { Select } from '../../components/primitives'
import { ErrorNote, IconButton, Modal, Spinner } from '../../components/ui'
import { targetDisplayName } from '../../components/targetName'
import { call } from '../../lib/backend'
import { friendlyError } from '../../lib/errors'
import { useTargets } from '../../store/targets'

const sourceLabel = (status: RgPluginStatus): string => {
  if (status.source === 'system') return t('正在复用系统 rg {version}', { version: status.version ?? '' })
  if (status.source === 'managed') return t('正在使用托管 rg {version}', { version: status.version ?? '' })
  return t('正在使用内置搜索')
}

export function PluginsSection() {
  const targets = useTargets((state) => state.targets)
  const selected = useTargets((state) => state.selectedId)
  const [selection, setSelection] = useState(selected)
  const target = targets.find((item) => item.id === selection) ?? targets[0]
  const id = target?.id
  const ready = useTargets((state) => id !== undefined && state.states[id]?.state === 'ready')
  const [revision, setRevision] = useState(0)
  const [packages, setPackages] = useState<RgPluginInfo[]>([])
  const [loadingPackages, setLoadingPackages] = useState(true)
  const [inspection, setInspection] = useState<{ id: string; revision: number; status?: RgPluginStatus; error?: string }>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [install, setInstall] = useState<{ id: string; targetName: string; info: RgPluginInfo }>()
  const [remove, setRemove] = useState<{ id: string; targetName: string }>()
  const current = ready && inspection?.id === id && inspection?.revision === revision ? inspection : undefined
  const status = current?.status
  const matching = packages.find((item) => item.platform === status?.platform)

  useEffect(() => {
    let active = true
    void call('plugins.list').then((items) => {
      if (active) setPackages(items)
    }, (err: unknown) => {
      if (active) setError(friendlyError(err))
    }).finally(() => {
      if (active) setLoadingPackages(false)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!id || !ready) {
      setInspection(undefined)
      return
    }
    let active = true
    void call('plugins.status', { id }).then((status) => {
      if (active) setInspection({ id, revision, status })
    }, (err: unknown) => {
      if (active) setInspection({ id, revision, error: friendlyError(err) })
    })
    return () => { active = false }
  }, [id, ready, revision])

  const run = async (task: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      await task()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setPending(false)
    }
  }

  const importPackage = () => run(async () => {
    const path = await window.qn.openFile('plugin')
    if (!path) return
    const info = await call('plugins.import', { path })
    setPackages((previous) => [...previous.filter((item) => item.platform !== info.platform), info]
      .sort((a, b) => a.platform.localeCompare(b.platform)))
  })

  return (
    <div className="space-y-5">
      <ErrorNote message={error ?? null} onClose={() => setError(undefined)} />
      <div className="space-y-3 rounded-lg border border-qn-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-medium">ripgrep (rg)</h3>
            <p className="text-ui-sm text-qn-muted">{t('加速目标机上的文件名和内容搜索。')}</p>
          </div>
          <button type="button" className="qn-button" disabled={pending || loadingPackages} onClick={() => void importPackage()}>
            {t('导入离线包')}
          </button>
        </div>
        {packages.length > 0 && <ul className="space-y-1">
          {packages.map(({ platform, version }) => (
            <li key={platform} className="flex items-center justify-between gap-2 rounded-lg bg-qn-panel px-2.5">
              <span className="font-mono text-ui-sm text-qn-muted">{platform} · {version}</span>
              <IconButton size="sm" disabled={pending} label={t('清除 {platform} 离线包', { platform })} onClick={() => void run(async () => {
                await call('plugins.forget', { platform })
                setPackages((previous) => previous.filter((entry) => entry.platform !== platform))
              })}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>}
      </div>

      <div className="space-y-3 rounded-lg border border-qn-border p-4">
        <div className="flex items-center gap-2">
          <Select className="w-72 max-w-full" value={id ?? ''} onValueChange={setSelection} disabled={pending}
            aria-label={t('选择安装目标')}
            options={targets.map((item) => ({ value: item.id, label: targetDisplayName(item) }))} />
          <IconButton label={t('刷新')} disabled={!ready || pending} onClick={() => setRevision((value) => value + 1)}>
            <RotateCw size={15} />
          </IconButton>
        </div>
        <ErrorNote message={current?.error ?? null} />
        {!ready && <p className="text-ui-sm text-qn-muted">{t('请先连接目标')}</p>}
        {ready && !current && <Spinner label={t('正在检测 rg…')} />}
        {status && target && <>
          <p role="status" className="text-ui-sm text-qn-muted">{sourceLabel(status)}{status.platform && ` · ${status.platform}`}</p>
          {status.installed && status.source === 'system' && (
            <p className="text-ui-sm text-qn-muted">{t('已安装托管版 {version}，系统 rg 优先。', { version: status.installed.version })}</p>
          )}
          {target.kind === 'direct' ? <p className="text-ui-sm text-qn-muted">{t('直连目标需要由主机管理员安装或移除插件')}</p> : (
            <div className="flex flex-wrap items-center gap-2">
              {matching && matching.sha256 !== status.installed?.sha256 && (
                <button type="button" disabled={pending} className="qn-button-subtle"
                  onClick={() => setInstall({ id: target.id, targetName: targetDisplayName(target), info: matching })}>
                  {t('安装 rg {version}', { version: matching.version })}
                </button>
              )}
              {status.installed && (
                <button type="button" disabled={pending} className="qn-button-subtle"
                  onClick={() => setRemove({ id: target.id, targetName: targetDisplayName(target) })}>
                  {t('移除托管版')}
                </button>
              )}
              {!matching && status.platform && <p className="text-ui-sm text-qn-muted">{t('可导入 {platform} 的离线包。', { platform: status.platform })}</p>}
              {!status.platform && <p className="text-ui-sm text-qn-muted">{t('此平台暂无托管插件包。')}</p>}
            </div>
          )}
        </>}
      </div>

      {install && <Modal title={t('安装 rg {version}', { version: install.info.version })} onClose={() => setInstall(undefined)}
        description={t('将在 {target} 上运行插件自检。只安装来自可信来源的离线包。', { target: install.targetName })}
        footer={<div className="flex justify-end gap-2">
          <button type="button" className="qn-button-subtle" onClick={() => setInstall(undefined)}>{t('取消')}</button>
          <button type="button" className="qn-button" disabled={pending} onClick={() => {
            setInstall(undefined)
            void run(async () => {
              await call('plugins.install', { id: install.id, info: install.info })
              setRevision((value) => value + 1)
            })
          }}>{t('安装')}</button>
        </div>}>
        <p className="break-all font-mono text-ui-xs text-qn-muted">SHA-256 {install.info.sha256}</p>
      </Modal>}
      {remove && <Modal title={t('移除托管版')} onClose={() => setRemove(undefined)}
        description={t('移除 {target} 上的托管 rg？', { target: remove.targetName })}
        footer={<div className="flex justify-end gap-2">
          <button type="button" className="qn-button-subtle" onClick={() => setRemove(undefined)}>{t('取消')}</button>
          <button type="button" className="qn-button" disabled={pending} onClick={() => {
            setRemove(undefined)
            void run(async () => {
              await call('plugins.remove', { id: remove.id })
              setRevision((value) => value + 1)
            })
          }}>{t('移除')}</button>
        </div>}>
        <p className="text-ui-sm text-qn-muted">{t('可用的系统 rg 会继续用于搜索。')}</p>
      </Modal>}
    </div>
  )
}
