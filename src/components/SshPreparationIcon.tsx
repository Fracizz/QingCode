import { AlertTriangle, Cloud, LoaderCircle } from 'lucide-react'
import type { SyntheticEvent } from 'react'
import { useSshWarmupStore } from '../store/sshWarmupStore'
import { sshOpeningForPath, useSshOpeningStore } from '../store/sshOpeningStore'
import { setServerOperationBackground, useServerOperationStore } from '../store/serverOperationStore'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

export default function SshPreparationIcon({
  path,
  size,
  className,
}: {
  path: string
  size: number
  className?: string
}) {
  const status = useSshWarmupStore(state => state.statuses.get(path))
  const { t } = useI18n()
  const openingInBackground = useSshOpeningStore(
    state => {
      const attempt = sshOpeningForPath(state.attempts, path)
      return attempt?.background === true && !attempt.error
    }
  )
  const backgroundOperation = useServerOperationStore(state => {
    const task = state.tasks[path]
    return task?.background && !task.finishedAt ? task.kind : null
  })
  if (backgroundOperation && !openingInBackground) {
    const label = t(backgroundOperation === 'update' ? '正在后台更新远端服务，点击查看进度' : '正在后台安装远端服务，点击查看进度')
    // 点击只重新展开进度卡：阻止冒泡，点项目标签本身仍然是切换项目。
    const expand = (event: SyntheticEvent) => {
      event.stopPropagation()
      setServerOperationBackground(path, false)
    }
    return (
      <Tooltip label={label} side="bottom" wrapperClassName="inline-flex">
        <span
          role="button"
          tabIndex={0}
          aria-label={label}
          className="inline-flex cursor-pointer"
          onClick={expand}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            expand(event)
          }}
        >
          <LoaderCircle size={size} className="animate-spin text-accent" aria-hidden />
        </span>
      </Tooltip>
    )
  }
  if (openingInBackground) {
    const label = t('正在后台打开远程项目，点击查看进度')
    return (
      <Tooltip label={label} side="bottom" wrapperClassName="inline-flex">
        <span role="img" aria-label={label}>
          <LoaderCircle size={size} className="animate-spin text-accent" aria-hidden />
        </span>
      </Tooltip>
    )
  }
  if (!status || status.phase === 'ready') return <Cloud size={size} className={className} />
  const label =
    status.phase === 'queued'
      ? t('远程项目等待后台准备')
      : status.phase === 'preparing'
        ? t('远程项目正在后台准备，点击可继续打开')
        : status.phase === 'attention'
          ? t('远程项目需要认证或确认，点击处理')
          : t('远程项目后台准备失败，点击重试')
  const Icon =
    status.phase === 'preparing'
      ? LoaderCircle
      : status.phase === 'failed' || status.phase === 'attention'
        ? AlertTriangle
        : Cloud
  const color =
    status.phase === 'preparing'
      ? 'animate-spin text-accent'
      : status.phase === 'failed' || status.phase === 'attention'
        ? 'text-warn'
        : 'text-fg-muted'
  return (
    <Tooltip
      label={status.detail ? `${label}\n${status.detail}` : label}
      side="bottom"
      wrapperClassName="inline-flex"
    >
      <span role="img" aria-label={label}>
        <Icon size={size} className={color} aria-hidden />
      </span>
    </Tooltip>
  )
}
