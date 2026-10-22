import { parentPath, pathsEqual } from './fileReferences'

export const EXPLORER_DROP_ATTR = 'data-explorer-drop'
export const EXPLORER_UPLOAD_ATTR = 'data-explorer-upload'

export type ExplorerDropHit = { path: string; isDir: boolean }

export type SshUploadDrop = { destination: string; highlight: string }

/** Tauri file-drop positions are physical pixels of the webview client area. */
export function logicalDropPoint(
  position: { x: number; y: number },
  devicePixelRatio: number,
): { x: number; y: number } {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1
  return { x: position.x / scale, y: position.y / scale }
}

export function readExplorerDropHit(element: Element | null): ExplorerDropHit | null {
  const row = element?.closest(`[${EXPLORER_DROP_ATTR}]`)
  if (!(row instanceof Element)) return null
  const path = row.getAttribute(EXPLORER_DROP_ATTR)
  if (!path) return null
  return { path, isDir: row.getAttribute('data-explorer-isdir') === '1' }
}

export function isExplorerUploadZone(element: Element | null): boolean {
  return Boolean(element?.closest(`[${EXPLORER_UPLOAD_ATTR}]`))
}

/**
 * OS file drop onto an SSH explorer. Folders receive the drop; a file row
 * uploads into its parent. Empty tree space and the project heading use the
 * project root. Local projects and drops outside the tree are ignored.
 */
export function sshUploadDropFromQuery(
  project: { kind: string; path: string } | null | undefined,
  query: { inUploadZone: boolean; hit: ExplorerDropHit | null },
): SshUploadDrop | null {
  if (!project || project.kind !== 'ssh' || !project.path) return null
  const onProjectRoot =
    query.hit != null && query.hit.isDir && pathsEqual(query.hit.path, project.path)
  if (!query.inUploadZone && !onProjectRoot) return null
  const hit = query.inUploadZone || onProjectRoot ? query.hit : null
  if (!hit?.path) return { destination: project.path, highlight: project.path }
  const destination = hit.isDir ? hit.path : parentPath(hit.path)
  if (!destination) return null
  return { destination, highlight: hit.path }
}
