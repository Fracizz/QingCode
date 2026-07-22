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

export type GitFileContents = {
  original: string
  modified: string
}
