// 全屏程序开启鼠标上报时，xterm 会把小于 50px 的像素滚动打 3 折，且每个滚轮事件最多只发 1 格，
// 手机上每帧只有几像素位移，导致上滑很费劲。这里自己按「格」换算，每格派发一个按行的滚轮事件。

/** 每帧最多派发的格数；超出部分丢弃，避免把输入和画面重绘堆积在电脑端。 */
export const MAX_WHEEL_TICKS_PER_FRAME = 6;

/** 慢拖每行一格，快甩最多每行 1.25 格。起步和反向只需半行，避免细读时手指已动、画面仍不动。 */
export function wheelTicks(state, deltaPx, cellHeight, speed = 0) {
  if (!(cellHeight > 0) || !deltaPx) return 0;
  const direction = Math.sign(deltaPx);
  if (state.direction !== direction) {
    state.direction = direction;
    state.remainder = direction * .5;
  }
  const gain = 1 + Math.min(.25, Math.max(0, Math.abs(speed) - .5) / 6);
  state.remainder += deltaPx / cellHeight * gain;
  const ticks = Math.trunc(state.remainder);
  state.remainder -= ticks;
  return Math.max(-MAX_WHEEL_TICKS_PER_FRAME, Math.min(MAX_WHEEL_TICKS_PER_FRAME, ticks));
}

/** 本地记录滚动的增益：与 xterm 自身把像素滚轮换算成 1.25 倍滚动距离的手感保持一致。 */
export const LOCAL_SCROLL_GAIN = 1.25;

/**
 * 把像素位移累计成整行本地滚动，零头留到下一帧（含惯性），不会被输出打断丢失。
 * 返回本次应滚动的行数，负数表示向上。
 */
export function localScrollLines(state, deltaPx, cellHeight) {
  if (!(cellHeight > 0) || !deltaPx) return 0;
  state.remainder += deltaPx * LOCAL_SCROLL_GAIN / cellHeight;
  const lines = Math.trunc(state.remainder);
  state.remainder -= lines;
  return lines;
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

/**
 * Coalesce finger motion per frame, then coast without sending TUI keys after release.
 *
 * lineHeight / scrollLines：普通终端滚本地记录时，由这里按整行调用 scrollLines，不交给 xterm 的像素滚轮。
 * xterm 6 的视口在有输出换行时会把滚动位置对齐回整行（缓冲已满或刚离开底部时尤甚），
 * 手指每帧几像素的位移会被反复抹掉，输出中上滑就显得卡顿、发硬；整行滚动不受影响。
 * 滚轮事件仍会派发，历史面板（到顶接电脑端历史、面板内惯性）照常在捕获阶段先处理。
 */
/**
 * 长按只走一条路径：系统长按（WebView 发出的触摸 contextmenu，时长跟随系统设置）在捕获阶段被拦下并当作长按信号，
 * 不再交给 xterm 的右键处理（它会把隐藏输入框挪到手指下全选，引出系统原生选择、复制粘贴工具条和输入法）。
 * 少数 WebView 不发 contextmenu 时，longPressDelay 计时器兜底；同一次手势只触发一次。实体鼠标右键不受影响。
 */
export const TOUCH_LONG_PRESS_FALLBACK_MS = 650;

export function attachTerminalTouchScroll(element, { canInertia = () => true, onLongPress, programWheel, dispatchWheel = dispatchLineWheel, onProgramWheel, lineHeight, scrollLines, longPressDelay = TOUCH_LONG_PRESS_FALLBACK_MS } = {}) {
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
  // 手指是否仍按在终端上（长按触发后 gesture 已清空，但仍需把随后到达的触摸 contextmenu 拦下）。
  let touching = false;
  let pressedGesture = 0;
  const wheelState = { remainder: 0, direction: 0 };
  const lineState = { remainder: 0 };

  function dispatch(deltaY, momentum = false) {
    if (!deltaY) return;
    // programWheel 返回字符行高（px）时表示程序开了鼠标上报：按格发送。
    const cell = programWheel?.() || 0;
    if (cell > 0) {
      const ticks = wheelTicks(wheelState, deltaY, cell, velocity);
      if (ticks) {
        dispatchWheel(screen, ticks, point, { momentum, gesture: gestureId });
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
      qingGesture: { value: gestureId }, qingPixels: { value: true },
    });
    screen.dispatchEvent(wheel);
  }

  // 注册在历史面板的捕获监听之后：面板没有拦下的像素滚轮，在这里换成整行本地滚动，不再传给 xterm。
  function localWheel(event) {
    if (!event.qingPixels || !scrollLines) return;
    const cell = lineHeight?.() || 0;
    if (!(cell > 0)) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    const lines = localScrollLines(lineState, event.deltaY, cell);
    if (lines) scrollLines(lines);
  }

  function cancel() {
    view.clearTimeout(hold);
    hold = null;
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (coast !== null) view.cancelAnimationFrame(coast);
    frame = coast = null;
    pending = velocity = 0;
    wheelState.direction = wheelState.remainder = lineState.remainder = 0;
    gesture = null;
  }

  function flush() {
    frame = null;
    const delta = pending;
    pending = 0;
    dispatch(delta);
  }

  function longPress(origin) {
    if (!onLongPress || pressedGesture === gestureId) return;
    pressedGesture = gestureId;
    cancel();
    onLongPress(origin);
  }

  function start(event) {
    cancel();
    touching = event.touches.length > 0;
    if (event.touches.length !== 1 || !screen.contains(event.target)) return;
    const touch = event.touches[0];
    gestureId += 1;
    const now = view.performance.now();
    point = { x: touch.clientX, y: touch.clientY };
    gesture = { id: touch.identifier, x: point.x, y: point.y, previousY: point.y, at: now, axis: null };
    if (onLongPress) hold = view.setTimeout(() => {
      hold = null;
      longPress({ ...point });
    }, longPressDelay);
  }

  function contextMenu(event) {
    const firesTouchEvents = event.sourceCapabilities?.firesTouchEvents;
    if (firesTouchEvents === false || firesTouchEvents !== true && !touching) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    // 手指已滑动（滚动中）或不是从终端画面开始的触摸：只拦下，不进入选择。
    if (gesture && !gesture.axis) longPress({ x: event.clientX, y: event.clientY });
  }

  function release(event) {
    touching = event.touches?.length > 0;
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
      || view.document?.documentElement.dataset.motion === 'reduce'
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
  element.addEventListener('wheel', localWheel, { capture: true, passive: false });
  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchmove', move, { passive: false });
  element.addEventListener('touchend', end);
  element.addEventListener('touchcancel', cancel);
  element.addEventListener('touchend', release, true);
  element.addEventListener('touchcancel', release, true);
  // 捕获阶段：先于 xterm 挂在同一元素上的冒泡 contextmenu 监听。
  element.addEventListener('contextmenu', contextMenu, true);
  element.ownerDocument.addEventListener('visibilitychange', visibility);
  view.addEventListener('blur', cancel);
  const dispose = () => {
    cancel();
    touching = false;
    element.removeEventListener('wheel', localWheel, { capture: true });
    element.removeEventListener('touchstart', start);
    element.removeEventListener('touchmove', move);
    element.removeEventListener('touchend', end);
    element.removeEventListener('touchcancel', cancel);
    element.removeEventListener('touchend', release, true);
    element.removeEventListener('touchcancel', release, true);
    element.removeEventListener('contextmenu', contextMenu, true);
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
