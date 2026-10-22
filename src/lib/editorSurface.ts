export type EditorSurface = 'editor' | 'welcome' | 'blank'

/**
 * Welcome only when no project is open.
 * An open project with no file stays blank, including when the sidebar is collapsed.
 * Stay blank until the project list has loaded so startup does not flash the welcome.
 */
export function editorSurface(input: {
  activeTabId: string | null
  hasProject: boolean
  projectsReady: boolean
}): EditorSurface {
  if (input.activeTabId) return 'editor'
  if (!input.projectsReady || input.hasProject) return 'blank'
  return 'welcome'
}
