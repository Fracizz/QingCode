// 全屏程序开启鼠标上报时，xterm 会把小于 50px 的像素滚动打 3 折，且每个滚轮事件最多只发 1 格，
// 手机上每帧只有几像素位移，导致上滑很费劲。这里自己按「格」换算，每格派发一个按行的滚轮事件。

/** 手指每滑过一个字符行发几格滚轮（程序通常一格滚 1–3 行）。 */
export const PROGRAM_WHEEL_GAIN = .5;
/** 每帧最多派发的格数；超出部分丢弃，避免把输入和画面重绘堆积在电脑端。 */
export const MAX_WHEEL_TICKS_PER_FRAME = 6;

/** 把像素位移累计成整格滚轮；speed 为手指速度（px/ms），快甩时最多放大到 2.5 倍。 */
export function wheelTicks(state, deltaPx, cellHeight, speed = 0) {
  if (!(cellHeight > 0) || !deltaPx) return 0;
  // 换方向时丢掉上一方向的零头，避免回拉第一下没反应。
  if (state.remainder && Math.sign(state.remainder) !== Math.sign(deltaPx)) state.remainder = 0;
  const boost = 1 + Math.min(1.5, Math.max(0, Math.abs(speed) - .5));
  state.remainder += deltaPx / cellHeight * PROGRAM_WHEEL_GAIN * boost;
  const ticks = Math.trunc(state.remainder);
  state.remainder -= ticks;
  return Math.max(-MAX_WHEEL_TICKS_PER_FRAME, Math.min(MAX_WHEEL_TICKS_PER_FRAME, ticks));
}

/**
 * 派发 |ticks| 个按行（DOM_DELTA_LINE）的滚轮事件：xterm 每个事件向程序报告一格，
 * 编码（SGR / 默认）仍由 xterm 按程序请求的模式生成。ticks 为负表示向上。
 */
export function dispatchLineWheel(screen, ticks, point, extra = {}) {
  const view = screen.ownerDocument.defaultView;
  const count = Math.min(Math.abs(Math.trunc(ticks)), 64);
  for (let index = 0; index < count; index += 1) {
    const wheel = new view.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaMode: 1, deltaY: Math.sign(ticks),
      clientX: point.x, clientY: point.y,
    });
    Object.defineProperties(wheel, {
      wheelDeltaY: { value: undefined }, wheelDeltaX: { value: undefined },
      qingTouch: { value: true }, qingMomentum: { value: !!extra.momentum },
      qingGesture: { value: extra.gesture },
    });
    screen.dispatchEvent(wheel);
  }
  return count;
}

/**
 * 虚拟鼠标：在终端画面上派发一次合成鼠标事件（mousedown / mousemove / mouseup），
 * 由 xterm 按程序请求的鼠标模式编码上报。button：0 左键、2 右键；buttons 为按下中的键位掩码。
 * 事件带 qingVirtual 标记，触摸拦截不会把它当作「来自触摸的兼容事件」拦下。
 */
export function dispatchVirtualMouse(screen, type, point, { button = 0, buttons = 0, detail = 1 } = {}) {
  const view = screen.ownerDocument.defaultView;
  const event = new view.MouseEvent(type, {
    bubbles: true, cancelable: true, detail,
    clientX: point.x, clientY: point.y, button, buttons,
  });
  Object.defineProperty(event, 'qingVirtual', { value: true });
  screen.dispatchEvent(event);
  return event;
}

/** 虚拟鼠标一次完整点击：按下再抬起（双击由程序按两次点击的间隔自行判断）。 */
export function dispatchVirtualClick(screen, point, button = 0) {
  const mask = button === 2 ? 2 : button === 1 ? 4 : 1;
  dispatchVirtualMouse(screen, 'mousedown', point, { button, buttons: mask });
  dispatchVirtualMouse(screen, 'mouseup', point, { button, buttons: 0 });
}

/** Coalesce finger motion per frame, then coast without sending TUI keys after release. */
export function attachTerminalTouchScroll(element, { canInertia = () => true, onLongPress, programWheel, onProgramWheel } = {}) {
  const screen = element.querySelector('.xterm-screen');
  if (!screen) return () => {};
  const view = element.ownerDocument.defaultView;
  let gesture = null;
  let frame = null;
  let coast = null;
  let pending = 0;
  let velocity = 0;
  let hold = null;
  let point = { x: 0, y: 0 };
  let gestureId = 0;
  const wheelState = { remainder: 0 };

  function dispatch(deltaY, momentum = false) {
    if (!deltaY) return;
    // programWheel 返回字符行高（px）时表示程序开了鼠标上报：按格发送。
    const cell = programWheel?.() || 0;
    if (cell > 0) {
      const ticks = wheelTicks(wheelState, deltaY, cell, velocity);
      if (ticks) {
        dispatchLineWheel(screen, ticks, point, { momentum, gesture: gestureId });
        onProgramWheel?.(ticks);
      }
      return;
    }
    const wheel = new view.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaMode: 0, deltaY,
      clientX: point.x, clientY: point.y,
    });
    Object.defineProperties(wheel, {
      wheelDeltaY: { value: undefined }, wheelDeltaX: { value: undefined },
      qingTouch: { value: true }, qingMomentum: { value: momentum },
      qingGesture: { value: gestureId },
    });
    screen.dispatchEvent(wheel);
  }

  function cancel() {
    view.clearTimeout(hold);
    hold = null;
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (coast !== null) view.cancelAnimationFrame(coast);
    frame = coast = null;
    pending = velocity = 0;
    wheelState.remainder = 0;
    gesture = null;
  }

  function flush() {
    frame = null;
    const delta = pending;
    pending = 0;
    dispatch(delta);
  }

  function start(event) {
    cancel();
    if (event.touches.length !== 1 || !screen.contains(event.target)) return;
    const touch = event.touches[0];
    gestureId += 1;
    const now = view.performance.now();
    point = { x: touch.clientX, y: touch.clientY };
    gesture = { id: touch.identifier, x: point.x, y: point.y, previousY: point.y, at: now, axis: null };
    if (onLongPress) hold = view.setTimeout(() => {
      hold = null;
      const origin = { ...point };
      cancel();
      onLongPress(origin);
    }, 500);
  }

  function move(event) {
    if (!gesture) return;
    if (event.touches.length !== 1) { cancel(); return; }
    const touch = event.touches[0];
    if (touch.identifier !== gesture.id) { cancel(); return; }
    if (!gesture.axis) {
      const x = Math.abs(touch.clientX - gesture.x);
      const y = Math.abs(touch.clientY - gesture.y);
      if (Math.max(x, y) < 8) return;
      view.clearTimeout(hold);
      hold = null;
      gesture.axis = y > x ? 'vertical' : 'horizontal';
    }
    if (gesture.axis !== 'vertical') return;
    if (event.cancelable) event.preventDefault();
    const now = view.performance.now();
    const delta = gesture.previousY - touch.clientY;
    const elapsed = Math.max(8, now - gesture.at);
    velocity = Math.max(-2.5, Math.min(2.5, .25 * velocity + .75 * delta / elapsed));
    gesture.previousY = touch.clientY;
    gesture.at = now;
    point = { x: touch.clientX, y: touch.clientY };
    pending += delta;
    if (frame === null) frame = view.requestAnimationFrame(flush);
  }

  function end() {
    view.clearTimeout(hold);
    hold = null;
    const now = view.performance.now();
    const recent = gesture && now - gesture.at < 80 && gesture.axis === 'vertical';
    gesture = null;
    if (!recent || Math.abs(velocity) < .15 || !canInertia()
      || view.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let previous = now;
    const began = now;
    function tick(at) {
      coast = null;
      if (!canInertia()) return;
      const elapsed = Math.min(32, at - previous);
      previous = at;
      dispatch(velocity * elapsed, true);
      velocity *= Math.exp(-elapsed / 180);
      if (Math.abs(velocity) > .04 && at - began < 900) coast = view.requestAnimationFrame(tick);
    }
    coast = view.requestAnimationFrame(at => {
      previous = at;
      coast = view.requestAnimationFrame(tick);
    });
  }

  function visibility() { if (element.ownerDocument.hidden) cancel(); }
  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchmove', move, { passive: false });
  element.addEventListener('touchend', end);
  element.addEventListener('touchcancel', cancel);
  element.ownerDocument.addEventListener('visibilitychange', visibility);
  view.addEventListener('blur', cancel);
  const dispose = () => {
    cancel();
    element.removeEventListener('touchstart', start);
    element.removeEventListener('touchmove', move);
    element.removeEventListener('touchend', end);
    element.removeEventListener('touchcancel', cancel);
    element.ownerDocument.removeEventListener('visibilitychange', visibility);
    view.removeEventListener('blur', cancel);
  };
  dispose.cancel = cancel;
  return dispose;
}

/**
 * 全屏程序开启鼠标上报时，Android WebView 在点按后补发的兼容鼠标事件会被 xterm 当作点击发给程序。
 * 在容器捕获阶段拦下这些「来自触摸」的鼠标事件（实体鼠标不受影响），点按只用于聚焦终端。
 */
export function attachTouchMouseGuard(container, { shouldBlock, onTap } = {}) {
  const view = container.ownerDocument.defaultView;
  let touchedAt = -Infinity;
  const touched = () => { touchedAt = view.performance.now(); };
  function guard(event) {
    const firesTouchEvents = event.sourceCapabilities?.firesTouchEvents;
    const fromTouch = firesTouchEvents === true || firesTouchEvents !== false && view.performance.now() - touchedAt < 800;
    if (event.qingVirtual || !fromTouch || !shouldBlock?.()) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    if (event.type === 'mousedown') onTap?.(event);
  }
  const types = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  container.addEventListener('touchstart', touched, { capture: true, passive: true });
  container.addEventListener('touchend', touched, { capture: true, passive: true });
  for (const type of types) container.addEventListener(type, guard, true);
  return () => {
    container.removeEventListener('touchstart', touched, { capture: true });
    container.removeEventListener('touchend', touched, { capture: true });
    for (const type of types) container.removeEventListener(type, guard, true);
  };
}
