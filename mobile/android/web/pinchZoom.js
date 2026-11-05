// 终端双指缩放调整字号：按两指距离比例换算字号，限定在 11–20px；
// 整个双指手势不传给终端滚动或程序。Vitest：src/lib/mobileAndroidPinchZoom.test.ts。

export const FONT_MIN = 11;
export const FONT_MAX = 20;
/** 两指距离至少变化这么多像素才开始缩放，避免双指轻触时字号抖动。 */
export const PINCH_SLOP = 12;

export function clampFontSize(size) {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size)));
}

/** 起始字号按两指距离比例缩放后取整。 */
export function pinchFontSize(startSize, startDistance, distance) {
  if (!(startDistance > 0) || !(distance > 0)) return clampFontSize(startSize);
  return clampFontSize(startSize * distance / startDistance);
}

function spread(touches) {
  const [a, b] = touches;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * element：终端输出区容器。currentSize() 返回当前字号；onPreview(size) 在手势中实时预览；
 * onCommit(size) 松手后保存。onStart 用于取消正在进行的单指滚动、选字等手势。
 * 在捕获阶段监听，双指期间阻止事件继续传给 xterm 与滚动处理。
 */
export function attachPinchZoom(element, { currentSize, onStart, onPreview, onCommit, enabled = () => true } = {}) {
  let gesture = null;

  function start(event) {
    if (event.touches.length !== 2 || !enabled()) return;
    gesture = { distance: spread(event.touches), size: currentSize(), last: currentSize(), active: false };
    onStart?.();
    event.stopPropagation();
  }

  function move(event) {
    if (!gesture) return;
    if (event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    const distance = spread(event.touches);
    if (!gesture.active) {
      if (Math.abs(distance - gesture.distance) < PINCH_SLOP) return;
      gesture.active = true;
    }
    const size = pinchFontSize(gesture.size, gesture.distance, distance);
    if (size === gesture.last) return;
    gesture.last = size;
    onPreview?.(size);
  }

  function end(event) {
    if (!gesture) return;
    event.stopPropagation();
    // 抬起一指后手势结束；剩下的手指不再触发单指滚动。
    const finished = gesture;
    gesture = null;
    if (finished.active && finished.last !== finished.size) onCommit?.(finished.last);
    else onCommit?.(finished.size, { unchanged: true });
  }

  element.addEventListener('touchstart', start, { capture: true, passive: true });
  element.addEventListener('touchmove', move, { capture: true, passive: false });
  element.addEventListener('touchend', end, { capture: true });
  element.addEventListener('touchcancel', end, { capture: true });
  return () => {
    gesture = null;
    element.removeEventListener('touchstart', start, { capture: true });
    element.removeEventListener('touchmove', move, { capture: true });
    element.removeEventListener('touchend', end, { capture: true });
    element.removeEventListener('touchcancel', end, { capture: true });
  };
}
