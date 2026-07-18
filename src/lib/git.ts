export type GitChange = {
  path: string
  status: string
}

export type GitStatus = {
  is_repository: boolean
  branch: string | null
  changes: GitChange[]
}

export type GitFileContents = {
  original: string
  modified: string
}
