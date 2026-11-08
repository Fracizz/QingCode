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
      if (button.disabled) { stop(); return; }
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
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', stop);
  const dispose = () => {
    stop();
    button.removeEventListener('pointerdown', down);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.removeEventListener(type, stop);
    button.removeEventListener('click', click, true);
    window.removeEventListener('blur', stop);
    document.removeEventListener('visibilitychange', stop);
  };
  dispose.cancel = stop;
  return dispose;
}

/**
 * 长按触发（会话列表的操作菜单）：按住 delay 毫秒且移动不超过 slop 像素时调用 onLongPress。
 * 系统 contextmenu（WebView 长按、鼠标右键）同样触发并阻止默认菜单；触发后吞掉随后的 click。
 */
export function attachLongPress(element, onLongPress, { delay = 480, slop = 10 } = {}) {
  let timer = null;
  let origin = null;
  let fired = false;

  function stop() {
    clearTimeout(timer);
    timer = null;
    origin = null;
  }

  function fire() {
    stop();
    fired = true;
    navigator.vibrate?.(12);
    onLongPress();
  }

  function down(event) {
    stop();
    fired = false;
    // 鼠标右键只走 contextmenu，不计时。
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(fire, delay);
  }

  function move(event) {
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > slop) stop();
  }

  function context(event) {
    event.preventDefault();
    if (!fired) fire();
  }

  function click(event) {
    if (!fired) return;
    fired = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) element.addEventListener(type, stop);
  element.addEventListener('contextmenu', context);
  element.addEventListener('click', click, true);
  return () => {
    stop();
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) element.removeEventListener(type, stop);
    element.removeEventListener('contextmenu', context);
    element.removeEventListener('click', click, true);
  };
}

/**
 * 长按拖动排序（快捷键栏布局等短列表）：在 rowSelector 行上按住 delay 毫秒进入拖动，
 * 被拖行跟随手指，其余行让位；松手调用 onDrop(row, from, to)。按住期间移动超过 slop 视为滚动，放弃拖动。
 * 拖动后吞掉随后的 click，避免松手时误触行内的开关；ignoreSelector 内的控件（如上移 / 下移按钮）不触发拖动。
 * 落点计算在 keyLayout.js 的 dragTargetIndex。
 */
export function attachDragSort(list, { rowSelector, ignoreSelector, onDrop, targetIndex, delay = 320, slop = 8 }) {
  let pending = null;
  let drag = null;
  let swallowClick = false;

  function rows() { return [...list.querySelectorAll(rowSelector)]; }

  function clear() {
    clearTimeout(pending?.timer);
    pending = null;
    if (!drag) return;
    for (const row of drag.rows) {
      row.style.removeProperty('transform');
      row.style.removeProperty('transition');
    }
    drag.row.classList.remove('dragging');
    delete list.dataset.dragging;
    drag = null;
  }

  function begin() {
    const { row, pointerId, y } = pending;
    pending = null;
    if (!row.isConnected) return;
    const all = rows();
    const rects = all.map(item => item.getBoundingClientRect());
    const from = all.indexOf(row);
    const listRect = list.getBoundingClientRect();
    drag = {
      row, pointerId, y, from, to: from, rows: all,
      mids: rects.map(rect => rect.top + rect.height / 2),
      // 让位距离取相邻行的间距（含分隔线）；只有一行时不会让位。
      step: all.length > 1 ? (rects[all.length - 1].top - rects[0].top) / (all.length - 1) : rects[from].height,
      // 被拖行不超出列表上下边界。
      min: listRect.top - rects[from].top,
      max: listRect.bottom - rects[from].bottom,
    };
    try { row.setPointerCapture(pointerId); } catch { /* 捕获失败时仍靠列表冒泡跟踪。 */ }
    row.classList.add('dragging');
    list.dataset.dragging = 'true';
    for (const item of all) if (item !== row) item.style.transition = 'transform 160ms ease';
    navigator.vibrate?.(12);
  }

  function down(event) {
    clear();
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const row = event.target.closest?.(rowSelector);
    if (!row || !list.contains(row) || (ignoreSelector && event.target.closest(ignoreSelector))) return;
    pending = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(begin, delay) };
  }

  function move(event) {
    if (pending && event.pointerId === pending.pointerId) {
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > slop) clear();
      return;
    }
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const offset = Math.max(drag.min, Math.min(drag.max, event.clientY - drag.y));
    drag.row.style.transform = `translateY(${offset}px)`;
    drag.to = targetIndex(drag.mids, drag.from, drag.mids[drag.from] + offset);
    for (const [index, item] of drag.rows.entries()) {
      if (index === drag.from) continue;
      const shift = index > drag.from && index <= drag.to ? -drag.step : index < drag.from && index >= drag.to ? drag.step : 0;
      item.style.transform = shift ? `translateY(${shift}px)` : '';
    }
  }

  function up(event) {
    if (pending && event.pointerId === pending.pointerId) { clear(); return; }
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { row, from, to } = drag;
    swallowClick = true;
    // click 只在 pointerup 后同步派发；下一帧仍未出现说明不会再来，解除吞掉。
    setTimeout(() => { swallowClick = false; }, 0);
    clear();
    if (to !== from) onDrop(row, from, to);
  }

  function cancel(event) {
    if ((pending && event.pointerId === pending.pointerId) || (drag && event.pointerId === drag.pointerId)) clear();
  }

  // 拖动中阻止页面 / 弹层滚动；只在已进入拖动时取消，按住期间的滑动仍正常滚动。
  function touchMove(event) { if (drag) event.preventDefault(); }
  // WebView 长按会弹出系统菜单或选中文字，按住期间屏蔽。
  function context(event) { if (pending || drag) event.preventDefault(); }
  function click(event) {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  list.addEventListener('pointerdown', down);
  list.addEventListener('pointermove', move);
  list.addEventListener('pointerup', up);
  list.addEventListener('pointercancel', cancel);
  list.addEventListener('touchmove', touchMove, { passive: false });
  list.addEventListener('contextmenu', context);
  list.addEventListener('click', click, true);
  return () => {
    clear();
    list.removeEventListener('pointerdown', down);
    list.removeEventListener('pointermove', move);
    list.removeEventListener('pointerup', up);
    list.removeEventListener('pointercancel', cancel);
    list.removeEventListener('touchmove', touchMove);
    list.removeEventListener('contextmenu', context);
    list.removeEventListener('click', click, true);
  };
}
