// 输入框横向拖动移动光标（类似 iOS 空格键触控板）：横向拖过阈值后接管手势，
// 每移动一个步长产生一步；竖向拖动仍交给输入框自身滚动。
// 纯逻辑在前半部分，Vitest：src/lib/mobileAndroidCursorDrag.test.ts。

export const DRAG_SLOP = 10;

/** 判定手势方向：未超过阈值返回 null；横向需明显大于竖向才算，避免斜拉误触。 */
export function dragAxis(dx, dy, slop = DRAG_SLOP) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'horizontal' : 'vertical';
}

/** 把累积位移换算成整步（带符号，负数向左），余数留到下一次。 */
export function cursorSteps(accumulated, step) {
  if (!(step > 0)) return { steps: 0, remainder: 0 };
  const steps = Math.trunc(accumulated / step);
  return { steps, remainder: accumulated - steps * step };
}

/**
 * element：手势区域（命令输入框）。enabled() 为假时不接管（例如组词中、终端未就绪）。
 * step() 返回每一步的像素宽度；onSteps(n) 收到带符号步数；onStart / onEnd 用于切换视觉状态。
 */
export function attachCursorDrag(element, { enabled = () => true, step = () => 10, onStart, onSteps, onEnd } = {}) {
  const view = element.ownerDocument.defaultView;
  let gesture = null;
  let suppressClickUntil = 0;

  function start(event) {
    gesture = null;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastX: touch.clientX, axis: null, active: false, remainder: 0 };
  }

  function move(event) {
    if (!gesture) return;
    const touch = [...event.touches].find(item => item.identifier === gesture.id);
    if (!touch || event.touches.length !== 1) { finish(); return; }
    if (!gesture.axis) {
      gesture.axis = dragAxis(touch.clientX - gesture.x, touch.clientY - gesture.y);
      if (!gesture.axis) return;
      if (gesture.axis !== 'horizontal' || !enabled()) { gesture.axis = 'ignored'; return; }
      gesture.active = true;
      // 从越过阈值的位置开始计步，避免一开始就跳一格。
      gesture.lastX = touch.clientX;
      onStart?.();
    }
    if (!gesture.active) return;
    if (event.cancelable) event.preventDefault();
    const result = cursorSteps(gesture.remainder + touch.clientX - gesture.lastX, step());
    gesture.lastX = touch.clientX;
    gesture.remainder = result.remainder;
    if (result.steps) onSteps?.(result.steps);
  }

  function finish() {
    const active = gesture?.active;
    gesture = null;
    if (!active) return;
    // 拖动结束后浏览器可能补发 click / focus，短时间内吞掉，避免切换输入模式。
    suppressClickUntil = view.performance.now() + 400;
    onEnd?.();
  }

  function click(event) {
    if (view.performance.now() > suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchmove', move, { passive: false });
  element.addEventListener('touchend', finish);
  element.addEventListener('touchcancel', finish);
  element.addEventListener('click', click, true);
  const dispose = () => {
    finish();
    element.removeEventListener('touchstart', start);
    element.removeEventListener('touchmove', move);
    element.removeEventListener('touchend', finish);
    element.removeEventListener('touchcancel', finish);
    element.removeEventListener('click', click, true);
  };
  dispose.isDragging = () => !!gesture?.active;
  return dispose;
}
