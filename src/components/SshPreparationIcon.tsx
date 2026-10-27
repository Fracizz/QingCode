import { AlertTriangle, Cloud, LoaderCircle } from 'lucide-react'
import { useSshWarmupStore } from '../store/sshWarmupStore'
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
  if (!status) return <Cloud size={size} className={className} />
  const label =
    status.phase === 'queued'
      ? t('远程项目等待后台准备')
      : status.phase === 'preparing'
        ? t('远程项目正在后台准备，点击可继续打开')
        : status.phase === 'ready'
          ? t('远程项目已准备，可直接打开')
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
      : status.phase === 'ready'
        ? 'text-ok'
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
