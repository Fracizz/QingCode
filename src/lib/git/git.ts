export type GitChange = {
  path: string
  /** Full two-character porcelain XY status (`M `, ` M`, `MM`, `??`, …). */
  status: string
}

export type GitStatus = {
  is_repository: boolean
  branch: string | null
  /** Upstream short ref when the current branch tracks a remote. */
  upstream?: string | null
  /** Remote commits not yet merged locally. */
  behind?: number
  /** Local commits not yet on the remote. */
  ahead?: number
  /** Last `git fetch` time (ms since epoch), from FETCH_HEAD mtime. */
  last_fetch_at?: number | null
  /** Last pull/merge from remote (ms since epoch), from HEAD reflog. */
  last_pull_at?: number | null
  /** Last push time (ms since epoch), from HEAD reflog when available. */
  last_push_at?: number | null
  changes: GitChange[]
}

export type GitPullResult = {
  summary: string
  has_conflicts: boolean
  conflict_paths: string[]
}

export type GitBranchInfo = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchList = {
  local: GitBranchInfo[]
  remote: string[]
}

export type GitRemote = {
  name: string
  fetch_url: string | null
  push_urls: string[]
}

export type GitCommitInfo = {
  hash: string
  short_hash: string
  subject: string
  author: string
  date: string
  /** Branch / tag decorations (`git log %D`); may be empty. */
  refs: string
}

export type GitCommitFileChange = {
  status: string
  path: string
  previous_path: string | null
}

export type GitFileContents = {
  original: string
  modified: string
}
