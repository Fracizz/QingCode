/** 图片查看器的缩放 / 平移 / 旋转纯计算，组件只负责事件与渲染。 */

export type Size = { width: number; height: number }
export type Point = { x: number; y: number }

export const MIN_SCALE = 0.05
export const MAX_SCALE = 32
/** 放大到该倍数及以上时改用最近邻插值，便于查看像素细节（图标、截图）。 */
export const PIXELATED_SCALE = 3
/** 平移时图片至少保留在视口内的像素数，避免拖丢。 */
const KEEP_VISIBLE = 64

/** 按钮 / 键盘缩放使用的档位，比固定倍率更易回到整数比例。 */
const ZOOM_LEVELS = [
  0.05, 0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32,
]

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** 下一个（更大）缩放档位。 */
export function nextZoomLevel(scale: number): number {
  return ZOOM_LEVELS.find(level => level > scale * 1.001) ?? MAX_SCALE
}

/** 上一个（更小）缩放档位。 */
export function prevZoomLevel(scale: number): number {
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
    if (ZOOM_LEVELS[i] < scale / 1.001) return ZOOM_LEVELS[i]
  }
  return MIN_SCALE
}

/**
 * 滚轮 / 触控板捏合的缩放倍率：与滚动量成指数关系，
 * 鼠标一格（约 100px）≈ 1.22 倍，触控板小增量则平滑连续。
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pageHeight = 800): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageHeight : deltaY
  const factor = Math.exp(-px * 0.002)
  return Math.min(2, Math.max(0.5, factor))
}

/** 旋转 quarterTurns 个 90° 后的包围盒尺寸。 */
export function rotatedSize(natural: Size, quarterTurns: number): Size {
  return Math.abs(quarterTurns) % 2 === 1
    ? { width: natural.height, height: natural.width }
    : natural
}

/** 包围盒完整放入视口（留 padding）所需倍率。 */
export function fitScaleFor(box: Size, viewport: Size, padding: number): number {
  if (box.width <= 0 || box.height <= 0) return 1
  return Math.min(
    Math.max(0.01, (viewport.width - padding) / box.width),
    Math.max(0.01, (viewport.height - padding) / box.height),
  )
}

/** 让包围盒在视口中居中的左上角偏移。 */
export function centeredOffset(box: Size, scale: number, viewport: Size): Point {
  return {
    x: (viewport.width - box.width * scale) / 2,
    y: (viewport.height - box.height * scale) / 2,
  }
}

/** 限制偏移，使图片在每个方向上至少有一段留在视口内。 */
export function clampOffset(offset: Point, box: Size, scale: number, viewport: Size): Point {
  const clampAxis = (value: number, content: number, view: number) => {
    const keep = Math.min(KEEP_VISIBLE, content, view)
    return Math.min(view - keep, Math.max(keep - content, value))
  }
  return {
    x: clampAxis(offset.x, box.width * scale, viewport.width),
    y: clampAxis(offset.y, box.height * scale, viewport.height),
  }
}

/** 以 anchor（视口坐标）为不动点从 fromScale 缩放到 toScale 后的新偏移。 */
export function zoomOffsetAt(offset: Point, fromScale: number, toScale: number, anchor: Point): Point {
  const cx = (anchor.x - offset.x) / fromScale
  const cy = (anchor.y - offset.y) / fromScale
  return { x: anchor.x - cx * toScale, y: anchor.y - cy * toScale }
}

/**
 * CSS transform（transform-origin 为左上角）：先把位图绕自身中心旋转，
 * 再平移到包围盒中心、按 scale 缩放、移到 offset。
 */
export function imageTransform(
  offset: Point,
  scale: number,
  natural: Size,
  quarterTurns: number,
): string {
  const box = rotatedSize(natural, quarterTurns)
  return [
    `translate(${offset.x}px, ${offset.y}px)`,
    `scale(${scale})`,
    `translate(${box.width / 2}px, ${box.height / 2}px)`,
    `rotate(${quarterTurns * 90}deg)`,
    `translate(${-natural.width / 2}px, ${-natural.height / 2}px)`,
  ].join(' ')
}
