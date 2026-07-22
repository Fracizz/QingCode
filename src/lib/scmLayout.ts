export const SCM_LAYOUT_KEY = 'qingcode:scm-layout'

export const SCM_LEFT_MIN = 220
export const SCM_LEFT_DEFAULT = 340
export const SCM_LEFT_MAX = 560
/** Keep room for the right pane (diff / commit detail). */
export const SCM_LEFT_REMAINING_MIN = 280

export const SCM_FILES_MIN = 160
export const SCM_FILES_DEFAULT = 240
export const SCM_FILES_MAX = 400
/** Keep room for the commit file diff pane. */
export const SCM_FILES_REMAINING_MIN = 240

export type ScmLayout = {
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

export function loadScmLayout(): ScmLayout {
  try {
    const raw = localStorage.getItem(SCM_LAYOUT_KEY)
    if (!raw) {
      return { leftWidth: SCM_LEFT_DEFAULT, filesWidth: SCM_FILES_DEFAULT }
    }
    const parsed = JSON.parse(raw) as Partial<ScmLayout>
    return {
      leftWidth: clampScmLeftWidth(
        typeof parsed.leftWidth === 'number' ? parsed.leftWidth : SCM_LEFT_DEFAULT,
      ),
      filesWidth: clampScmFilesWidth(
        typeof parsed.filesWidth === 'number' ? parsed.filesWidth : SCM_FILES_DEFAULT,
      ),
    }
  } catch {
    return { leftWidth: SCM_LEFT_DEFAULT, filesWidth: SCM_FILES_DEFAULT }
  }
}

export function saveScmLayout(next: ScmLayout) {
  const layout: ScmLayout = {
    leftWidth: clampScmLeftWidth(next.leftWidth),
    filesWidth: clampScmFilesWidth(next.filesWidth),
  }
  localStorage.setItem(SCM_LAYOUT_KEY, JSON.stringify(layout))
}
