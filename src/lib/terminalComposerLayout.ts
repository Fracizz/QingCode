/** 「编辑长文本」浮动面板的位置与尺寸：纯函数，便于测试。 */

export interface ComposerRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

export const COMPOSER_RECT_STORAGE_KEY = 'qingcode:terminal-composer-rect'
export const COMPOSER_MIN_WIDTH = 420
export const COMPOSER_MIN_HEIGHT = 320
/** 面板与视口边缘的最小留白。 */
const EDGE = 8
/** 拖出视口时至少保留的标题栏可见宽度/高度，保证还能拖回来。 */
const KEEP_VISIBLE_X = 160
const KEEP_VISIBLE_Y = 48

/** 默认：宽 800、高约 82% 视口（上限 820），水平垂直居中。 */
export function defaultComposerRect(viewport: Viewport): ComposerRect {
  const width = Math.max(Math.min(800, viewport.width - EDGE * 4), Math.min(COMPOSER_MIN_WIDTH, viewport.width - EDGE * 2))
  const height = Math.max(
    Math.min(Math.round(viewport.height * 0.82), 820, viewport.height - EDGE * 2),
    Math.min(COMPOSER_MIN_HEIGHT, viewport.height - EDGE * 2)
  )
  return {
    x: Math.round((viewport.width - width) / 2),
    y: Math.round((viewport.height - height) / 2),
    width,
    height,
  }
}

/** 尺寸不超过视口；位置允许部分移出，但标题栏必须留在视口内可拖回。 */
export function clampComposerRect(rect: ComposerRect, viewport: Viewport): ComposerRect {
  const width = Math.round(Math.min(Math.max(rect.width, COMPOSER_MIN_WIDTH), viewport.width - EDGE * 2))
  const height = Math.round(Math.min(Math.max(rect.height, COMPOSER_MIN_HEIGHT), viewport.height - EDGE * 2))
  const keepX = Math.min(KEEP_VISIBLE_X, width)
  const x = Math.round(Math.min(Math.max(rect.x, keepX - width), viewport.width - keepX))
  const y = Math.round(Math.min(Math.max(rect.y, 0), viewport.height - KEEP_VISIBLE_Y))
  return { x, y, width: Math.max(width, 0), height: Math.max(height, 0) }
}

export function parseComposerRect(raw: string | null): ComposerRect | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ComposerRect>
    const fields = [value.x, value.y, value.width, value.height]
    if (!fields.every(field => typeof field === 'number' && Number.isFinite(field))) return null
    return value as ComposerRect
  } catch {
    return null
  }
}

export function loadComposerRect(viewport: Viewport): ComposerRect {
  let stored: ComposerRect | null
  try {
    stored = parseComposerRect(localStorage.getItem(COMPOSER_RECT_STORAGE_KEY))
  } catch {
    stored = null
  }
  return clampComposerRect(stored ?? defaultComposerRect(viewport), viewport)
}

export function saveComposerRect(rect: ComposerRect) {
  try {
    localStorage.setItem(COMPOSER_RECT_STORAGE_KEY, JSON.stringify(rect))
  } catch {
    // 存储不可用时只影响下次打开的位置。
  }
}
