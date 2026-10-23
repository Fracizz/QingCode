export type EditorSurface = 'editor' | 'welcome' | 'blank'

/**
 * Projects that have already shown a file in the editor this session.
 * Closing those tabs stays blank; the welcome does not come back.
 */
const projectsPastWelcome = new Set<string>()

export function resetEditorWelcomeSession(): void {
  projectsPastWelcome.clear()
}

/** The project has opened a file, so later empty editor slots stay blank. */
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
 * After a file has been opened, an empty editor stays blank.
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
  return 'blank'
}
