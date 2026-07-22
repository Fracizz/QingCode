export const SCM_LAYOUT_KEY = 'qingcode:scm-layout'
/** Bump when defaults change so narrow legacy layouts upgrade once. */
export const SCM_LAYOUT_VERSION = 2

export const SCM_LEFT_MIN = 220
export const SCM_LEFT_DEFAULT = 300
export const SCM_LEFT_MAX = 560
/** Keep room for the right pane (diff / commit detail). */
export const SCM_LEFT_REMAINING_MIN = 280

export const SCM_FILES_MIN = 280
export const SCM_FILES_DEFAULT = 440
export const SCM_FILES_MAX = 680
/** Keep room for the commit file diff pane. */
export const SCM_FILES_REMAINING_MIN = 280

/** Pre-v2 default; used to detect stale narrow file panes. */
const LEGACY_FILES_DEFAULT = 240

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

    // One-shot upgrade: old installs kept the narrow 240px file column.
    if (version < SCM_LAYOUT_VERSION) {
      if (typeof parsed.filesWidth !== 'number' || parsed.filesWidth <= LEGACY_FILES_DEFAULT) {
        filesWidth = SCM_FILES_DEFAULT
      } else {
        filesWidth = clampScmFilesWidth(parsed.filesWidth)
      }
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
