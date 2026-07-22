export type GitChange = {
  path: string
  /** Full two-character porcelain XY status (`M `, ` M`, `MM`, `??`, …). */
  status: string
}

export type GitStatus = {
  is_repository: boolean
  branch: string | null
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
