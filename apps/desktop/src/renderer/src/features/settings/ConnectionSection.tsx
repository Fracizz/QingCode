import { useEffect } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { SshTarget, Target } from '../../../../shared/backendApi'
import { EmptyState } from '../../components/ui'
import { useTargets } from '../../store/targets'

function kindLabel(target: Target): string {
  if (target.kind === 'local') return '本机'
  if (target.kind === 'ssh') return 'SSH'
  return '直连'
}

function addressOf(target: Target): string {
  if (target.kind === 'local') return '本机进程'
  return `${target.host}:${target.port}`
}

/** 只读列表；编辑/删除交回宿主，避免在此重复实现连接表单。 */
export function ConnectionSection({
  onEditTarget,
  onRemoveTarget,
}: {
  onEditTarget?: (target: SshTarget) => void
  onRemoveTarget?: (id: string) => void
}) {
  const targets = useTargets((state) => state.targets)
  const loaded = useTargets((state) => state.loaded)
  const load = useTargets((state) => state.load)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  if (targets.length === 0) {
    return <EmptyState>正在读取已保存的连接…</EmptyState>
  }

  return (
    <ul className="space-y-1.5">
      {targets.map((target) => (
        <li
          key={target.id}
          className="flex items-center gap-3 rounded-lg border border-qn-border bg-qn-fg/[0.02] px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-ui text-qn-text">{target.name}</span>
              <span className="rounded-md bg-qn-fg/[0.06] px-1.5 text-ui-xs leading-5 text-qn-muted">
                {kindLabel(target)}
              </span>
            </div>
            <div className="truncate font-mono text-ui-sm text-qn-dim">{addressOf(target)}</div>
          </div>
          {target.kind === 'ssh' && onEditTarget && (
            <button
              type="button"
              className="qn-button-subtle flex shrink-0 items-center gap-1 px-2.5 py-1 text-ui-sm"
              onClick={() => onEditTarget(target)}
            >
              <Pencil size={13} /> 编辑
            </button>
          )}
          {target.kind !== 'local' && onRemoveTarget && (
            <button
              type="button"
              className="qn-button-subtle flex shrink-0 items-center gap-1 px-2.5 py-1 text-ui-sm text-qn-danger"
              onClick={() => onRemoveTarget(target.id)}
            >
              <Trash2 size={13} /> 删除
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
