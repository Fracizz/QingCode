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
