export const SCM_LAYOUT_KEY = 'qingcode:scm-layout'
/** Bump when defaults / history layout semantics change so installs upgrade once. */
export const SCM_LAYOUT_VERSION = 3

export const SCM_LEFT_MIN = 220
/** Changes tab left list default. */
export const SCM_LEFT_DEFAULT = 340
export const SCM_LEFT_MAX = 560
/** Keep room for the right pane (diff / commit detail). */
export const SCM_LEFT_REMAINING_MIN = 280

/**
 * History detail column (summary + files). Default ~2/5 of a typical window so the
 * commit list / diff side keeps ~3/5 via flex-1.
 */
export const SCM_FILES_MIN = 320
export const SCM_FILES_DEFAULT = 520
export const SCM_FILES_MAX = 720
/** Keep room for the left history pane (commit list or diff). */
export const SCM_FILES_REMAINING_MIN = 360

export type ScmLayout = {
  version: number
  leftWidth: number
  filesWidth: number
}

function clamp(width: number, min: number, max: number, containerWidth?: number, remainingMin = 0) {
  let safeMax = max
  if (containerWidth != null && containerWidth > 0) {
    safeMax = Math.min(safeMax, Math.max(min, containerWidth - remainingMin))
  }
  return Math.min(safeMax, Math.max(min, Math.round(width)))
}

export function clampScmLeftWidth(width: number, containerWidth?: number) {
  return clamp(width, SCM_LEFT_MIN, SCM_LEFT_MAX, containerWidth, SCM_LEFT_REMAINING_MIN)
}

export function clampScmFilesWidth(width: number, containerWidth?: number) {
  return clamp(width, SCM_FILES_MIN, SCM_FILES_MAX, containerWidth, SCM_FILES_REMAINING_MIN)
}

function defaults(): ScmLayout {
  return {
    version: SCM_LAYOUT_VERSION,
    leftWidth: SCM_LEFT_DEFAULT,
    filesWidth: SCM_FILES_DEFAULT,
  }
}

export function loadScmLayout(): ScmLayout {
  try {
    const raw = localStorage.getItem(SCM_LAYOUT_KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as Partial<ScmLayout>
    const version = typeof parsed.version === 'number' ? parsed.version : 1
    let leftWidth = clampScmLeftWidth(
      typeof parsed.leftWidth === 'number' ? parsed.leftWidth : SCM_LEFT_DEFAULT,
    )
    let filesWidth = clampScmFilesWidth(
      typeof parsed.filesWidth === 'number' ? parsed.filesWidth : SCM_FILES_DEFAULT,
    )

    if (version < SCM_LAYOUT_VERSION) {
      // History layout is now list/diff (~3/5) + detail (~2/5); refresh detail width.
      filesWidth = SCM_FILES_DEFAULT
      const upgraded = { version: SCM_LAYOUT_VERSION, leftWidth, filesWidth }
      saveScmLayout(upgraded)
      return upgraded
    }

    return { version: SCM_LAYOUT_VERSION, leftWidth, filesWidth }
  } catch {
    return defaults()
  }
}

export function saveScmLayout(next: Omit<ScmLayout, 'version'> & { version?: number }) {
  const layout: ScmLayout = {
    version: SCM_LAYOUT_VERSION,
    leftWidth: clampScmLeftWidth(next.leftWidth),
    filesWidth: clampScmFilesWidth(next.filesWidth),
  }
  localStorage.setItem(SCM_LAYOUT_KEY, JSON.stringify(layout))
}
