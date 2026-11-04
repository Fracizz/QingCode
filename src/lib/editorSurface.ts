export type EditorSurface = 'editor' | 'welcome' | 'projectIdle' | 'blank'

/**
 * Projects that have already shown a file in the editor this session.
 * Closing those tabs shows the light project idle view; the welcome does not come back.
 */
const projectsPastWelcome = new Set<string>()

export function resetEditorWelcomeSession(): void {
  projectsPastWelcome.clear()
}

/** The project has opened a file, so later empty editor slots use the project idle view. */
export function noteProjectEditorOpened(projectId: string | null): void {
  if (projectId) projectsPastWelcome.add(projectId)
}

/** True until this project has opened a file in the current session. */
export function isProjectWelcomePending(projectId: string | null): boolean {
  return projectId != null && !projectsPastWelcome.has(projectId)
}

/**
 * Welcome shares the editor column (the top-right editor toggle).
 * Show it when that column is visible and this is the first look at a project
 * that has no file yet — or when no project is open.
 * After a file has been opened, an empty editor shows the light project idle view
 * (project-scoped actions + recent files) instead of the full welcome.
 * Stay blank until the project list has loaded so startup does not flash the welcome.
 */
export function editorSurface(input: {
  activeTabId: string | null
  hasProject: boolean
  projectsReady: boolean
  /** Editor column is on screen. Hiding it hides the welcome with it. */
  editorVisible: boolean
  /** Project has not opened a file yet this session. */
  projectWelcome: boolean
}): EditorSurface {
  if (input.activeTabId) return 'editor'
  if (!input.projectsReady || !input.editorVisible) return 'blank'
  if (!input.hasProject || input.projectWelcome) return 'welcome'
  return 'projectIdle'
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Parent directory of a recent file for display, relative to the project root.
 * Returns '' for files directly under the root; falls back to the absolute parent
 * when the file lives outside the project.
 */
export function recentFileParentLabel(projectPath: string, filePath: string): string {
  const file = normalizeSlashes(filePath)
  const slash = file.lastIndexOf('/')
  const parent = slash >= 0 ? file.slice(0, slash) : ''
  const root = normalizeSlashes(projectPath)
  if (!root) return parent
  const lowerParent = parent.toLowerCase()
  const lowerRoot = root.toLowerCase()
  if (lowerParent === lowerRoot) return ''
  if (lowerParent.startsWith(`${lowerRoot}/`)) return parent.slice(root.length + 1)
  return parent
}
