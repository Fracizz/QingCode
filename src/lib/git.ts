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

export const GIT_STATUS_UPDATED_EVENT = 'qingcode:git-status-updated'

export function notifyGitStatusUpdated() {
  window.dispatchEvent(new Event(GIT_STATUS_UPDATED_EVENT))
}
