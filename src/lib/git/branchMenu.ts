import type { GitBranchInfo, GitBranchList } from './git'

export type BranchMenuRow =
  | { type: 'header'; key: string; label: string; count: number }
  | { type: 'local'; key: string; branch: GitBranchInfo }
  | { type: 'remote'; key: string; name: string }
  | { type: 'empty'; key: string; label: string }

export const BRANCH_MENU_VIRTUALIZE_THRESHOLD = 20

export function filterGitBranches(list: GitBranchList, query: string): GitBranchList {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return list
  return {
    local: list.local.filter(
      branch =>
        branch.name.toLowerCase().includes(normalized) ||
        (branch.upstream?.toLowerCase().includes(normalized) ?? false)
    ),
    remote: list.remote.filter(name => name.toLowerCase().includes(normalized)),
  }
}

export function buildBranchMenuRows(
  list: GitBranchList | null,
  query: string,
  labels: {
    local: string
    remote: string
    noLocal: string
    noMatch: string
    loading: string
  }
): BranchMenuRow[] {
  if (!list) {
    return [{ type: 'empty', key: 'loading', label: labels.loading }]
  }

  const filtered = filterGitBranches(list, query)
  const hasQuery = query.trim().length > 0
  const rows: BranchMenuRow[] = []

  rows.push({
    type: 'header',
    key: 'header-local',
    label: labels.local,
    count: filtered.local.length,
  })
  if (filtered.local.length === 0) {
    rows.push({
      type: 'empty',
      key: 'empty-local',
      label: hasQuery ? labels.noMatch : labels.noLocal,
    })
  } else {
    for (const branch of filtered.local) {
      rows.push({ type: 'local', key: `local:${branch.name}`, branch })
    }
  }

  if (list.remote.length > 0) {
    rows.push({
      type: 'header',
      key: 'header-remote',
      label: labels.remote,
      count: filtered.remote.length,
    })
    if (filtered.remote.length === 0) {
      rows.push({
        type: 'empty',
        key: 'empty-remote',
        label: labels.noMatch,
      })
    } else {
      for (const name of filtered.remote) {
        rows.push({ type: 'remote', key: `remote:${name}`, name })
      }
    }
  }

  return rows
}

export function selectableBranchMenuRows(rows: BranchMenuRow[]): string[] {
  return rows.flatMap(row => {
    if (row.type === 'local' && !row.branch.current) return [row.branch.name]
    if (row.type === 'remote') return [row.name]
    return []
  })
}

export function branchMenuRowHeight(row: BranchMenuRow | undefined): number {
  if (!row) return 34
  switch (row.type) {
    case 'header':
      return 26
    case 'local':
      return row.branch.upstream ? 44 : 34
    case 'remote':
      return 32
    case 'empty':
      return 34
    default:
      return 34
  }
}
