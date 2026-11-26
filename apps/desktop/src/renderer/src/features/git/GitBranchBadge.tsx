import { useEffect } from 'react'
import { GitBranch } from 'lucide-react'
import { Tip } from '../../components/primitives'
import { aheadBehindBadge, aheadBehindText, branchLabel, repoKey } from './gitModel'
import { useGit } from './gitStore'

/** 状态栏/标题栏用的紧凑徽标：分支名 + ahead/behind，悬停显示完整文案。 */
export function GitBranchBadge({ targetId, cwd }: { targetId: string; cwd: string }) {
  const key = repoKey(targetId, cwd)
  const status = useGit((s) => s.repos[key]?.status)
  const refresh = useGit((s) => s.refresh)

  useEffect(() => {
    void refresh(targetId, cwd, false)
  }, [targetId, cwd, refresh])

  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const badge = aheadBehindBadge(ahead, behind)

  return (
    <Tip label={aheadBehindText(ahead, behind)}>
      <span className="inline-flex max-w-52 items-center gap-1 text-[12px] text-qn-muted">
        <GitBranch size={13} className="shrink-0" />
        <span className="truncate">{branchLabel(status?.branch ?? null)}</span>
        {badge && <span className="shrink-0 font-mono text-[11px] text-qn-accent">{badge}</span>}
      </span>
    </Tip>
  )
}
