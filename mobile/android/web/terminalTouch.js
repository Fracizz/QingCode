/** Coalesce finger motion per frame, then coast without sending TUI keys after release. */
export function attachTerminalTouchScroll(element, { canInertia = () => true, onLongPress } = {}) {
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

  function dispatch(deltaY, momentum = false) {
    if (!deltaY) return;
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
    const fromTouch = event.sourceCapabilities?.firesTouchEvents === true || view.performance.now() - touchedAt < 800;
    if (!fromTouch || !shouldBlock?.()) return;
    event.stopPropagation();
    if (event.type === 'mousedown') onTap?.(event);
  }
  const types = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  container.addEventListener('touchstart', touched, { capture: true, passive: true });
  container.addEventListener('touchend', touched, { capture: true, passive: true });
  for (const type of types) container.addEventListener(type, guard, true);
  return () => {
    container.removeEventListener('touchstart', touched, { capture: true });
    container.removeEventListener('touchend', touched, { capture: true });
    for (const type of types) container.removeEventListener(type, guard, true);
  };
}
