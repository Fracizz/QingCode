// QingCode Android 的触摸手势：下拉刷新、底部弹层下滑关闭、快捷键长按连发。
// 只处理 DOM 事件；阈值与阻尼等纯逻辑在 protocol.js。Vitest：src/lib/mobileAndroidGestures.test.ts。
import { PULL_THRESHOLD, pullOffset } from './protocol.js';

/**
 * 列表顶部继续下拉时显示刷新指示，松手越过阈值则调用 onRefresh（返回 Promise）。
 * indicator 通过 data-state（pulling / ready / refreshing）与 --pull 变量驱动样式。
 */
export function attachPullToRefresh(scroller, indicator, { onRefresh, enabled = () => true }) {
  let gesture = null;
  let refreshing = false;

  function render(offset, state) {
    indicator.style.setProperty('--pull', offset + 'px');
    indicator.style.setProperty('--pull-progress', String(Math.min(1, offset / PULL_THRESHOLD)));
    if (state) indicator.dataset.state = state;
    else delete indicator.dataset.state;
  }

  function start(event) {
    gesture = null;
    if (refreshing || event.touches.length !== 1 || scroller.scrollTop > 0 || !enabled()) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, axis: null, offset: 0 };
  }

  function move(event) {
    if (!gesture) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== gesture.id) { cancel(); return; }
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      // 只接管向下的竖直拖动；横向滑动和向上滚动交还给列表。
      gesture.axis = dy > Math.abs(dx) ? 'pull' : 'other';
    }
    if (gesture.axis !== 'pull') return;
    if (dy <= 0 || scroller.scrollTop > 0) { cancel(); return; }
    if (event.cancelable) event.preventDefault();
    gesture.offset = pullOffset(dy);
    render(gesture.offset, gesture.offset >= PULL_THRESHOLD ? 'ready' : 'pulling');
  }

  async function end() {
    const ready = gesture?.axis === 'pull' && gesture.offset >= PULL_THRESHOLD;
    gesture = null;
    if (!ready) { render(0); return; }
    refreshing = true;
    render(PULL_THRESHOLD, 'refreshing');
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      render(0);
    }
  }

  function cancel() {
    gesture = null;
    if (!refreshing) render(0);
  }

  scroller.addEventListener('touchstart', start, { passive: true });
  scroller.addEventListener('touchmove', move, { passive: false });
  scroller.addEventListener('touchend', end);
  scroller.addEventListener('touchcancel', cancel);
  return () => {
    cancel();
    scroller.removeEventListener('touchstart', start);
    scroller.removeEventListener('touchmove', move);
    scroller.removeEventListener('touchend', end);
    scroller.removeEventListener('touchcancel', cancel);
  };
}

/** 底部弹层：按住拖动条下滑，超过距离或快速下甩时关闭，否则回弹。 */
export function attachSheetDrag(sheet, handle, close, { distance = 88, velocity = 0.6 } = {}) {
  let drag = null;

  function reset() {
    drag = null;
    sheet.style.removeProperty('transform');
    sheet.style.removeProperty('transition');
  }

  function down(event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    drag = { id: event.pointerId, y: event.clientY, at: event.timeStamp, offset: 0 };
    handle.setPointerCapture?.(event.pointerId);
    sheet.style.transition = 'none';
  }

  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag.offset = Math.max(0, event.clientY - drag.y);
    sheet.style.transform = `translateY(${drag.offset}px)`;
  }

  function up(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const elapsed = Math.max(1, event.timeStamp - drag.at);
    const dismiss = drag.offset >= distance || (drag.offset > 24 && drag.offset / elapsed >= velocity);
    reset();
    if (dismiss) close();
  }

  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', reset);
  return () => {
    reset();
    handle.removeEventListener('pointerdown', down);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', reset);
  };
}

/**
 * 长按连发（方向键、翻页）：按住 delay 毫秒后每 interval 毫秒调用 fire。
 * 发生过连发时吞掉随后的 click，避免松手再多发一次。
 */
export function attachKeyRepeat(button, fire, { delay = 420, interval = 70 } = {}) {
  let timer = null;
  let repeated = false;

  function stop() {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }

  function down(event) {
    if (button.disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    stop();
    repeated = false;
    timer = setTimeout(() => {
      repeated = true;
      fire();
      timer = setInterval(() => {
        if (button.disabled) stop();
        else fire();
      }, interval);
    }, delay);
  }

  function click(event) {
    if (!repeated) return;
    repeated = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  button.addEventListener('pointerdown', down);
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, stop);
  button.addEventListener('click', click, true);
  return () => {
    stop();
    button.removeEventListener('pointerdown', down);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.removeEventListener(type, stop);
    button.removeEventListener('click', click, true);
  };
}
