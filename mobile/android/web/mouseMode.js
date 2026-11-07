// 终端「鼠标模式」：长按右侧滑块（或「… → 鼠标模式」）进入。
// 模式内终端上会出现一只可拖动的虚拟鼠标：箭头尖端就是点击位置，拖机身移动指针，
// 点左 / 右键在尖端发出点击；按住左键滑动（或点左键后紧接着拖机身）相当于按住左键拖动，用于选中。
// 点终端空白处只把指针移过去，不点击。
// 点左下角胶囊、返回键、切换会话或离开终端时退出。

/** 按住滑块多久算长按，以及长按期间允许的手指抖动（px）。 */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 8;
/** 点按判定：位移与时长上限。 */
export const TAP_SLOP = 10;
export const TAP_MAX_MS = 500;
/** 虚拟鼠标机身尺寸（CSS px），以及机身相对箭头尖端的偏移。 */
export const MOUSE_BODY = { width: 72, height: 88 };
export const POINTER_GAP = { x: 14, y: 32 };
/** 箭头尖端在指针元素内的偏移（CSS px），摆放时扣除，让尖端正好落在点击位置。 */
export const POINTER_TIP = { x: 3, y: 3 };
/** 按住左键不动多久进入「按住拖动」（手指一滑动就会立即进入）。 */
export const HOLD_MS = 400;
/** 点左键后多久内拖动机身，算作接着按住左键拖动（单击后再滑动即选中）。 */
export const CLICK_DRAG_MS = 800;

/** 判断一次按下 / 抬起是否算点按（纯函数，便于测试）。 */
export function isTap(start, end, slop = TAP_SLOP, maxMs = TAP_MAX_MS) {
  if (!start || !end) return false;
  const elapsed = end.at - start.at;
  return Math.hypot(end.x - start.x, end.y - start.y) <= slop && elapsed >= 0 && elapsed <= maxMs;
}

/** 把点限制在矩形内（右 / 下边界各收 1px，保证仍落在最后一格里）。 */
export function clampPoint(point, rect) {
  return {
    x: Math.max(rect.left, Math.min(rect.left + Math.max(0, rect.width - 1), point.x)),
    y: Math.max(rect.top, Math.min(rect.top + Math.max(0, rect.height - 1), point.y)),
  };
}

/**
 * 终端画面与容器的相交部分：软键盘打开时终端保留行数，画面会超出容器，
 * 指针只能停在看得见的区域；不相交时退回画面本身。
 */
export function visibleRect(screen, bounds) {
  const left = Math.max(screen.left, bounds.left);
  const top = Math.max(screen.top, bounds.top);
  const width = Math.min(screen.left + screen.width, bounds.left + bounds.width) - left;
  const height = Math.min(screen.top + screen.height, bounds.top + bounds.height) - top;
  return width > 0 && height > 0 ? { left, top, width, height } : screen;
}

/** 指针位置与终端画面内相对比例互转，用于按会话记住位置、终端尺寸变化后恢复。 */
export function toRatio(point, rect) {
  return {
    x: rect.width ? (point.x - rect.left) / rect.width : .5,
    y: rect.height ? (point.y - rect.top) / rect.height : .5,
  };
}
export function fromRatio(ratio, rect) {
  return clampPoint({ x: rect.left + ratio.x * rect.width, y: rect.top + ratio.y * rect.height }, rect);
}

/** 箭头尖端所在字格的矩形；画面或行列无效时返回 null。 */
export function cellRect(point, rect, cols, rows) {
  if (!cols || !rows || !rect.width || !rect.height) return null;
  const width = rect.width / cols;
  const height = rect.height / rows;
  const col = Math.max(0, Math.min(cols - 1, Math.floor((point.x - rect.left) / width)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((point.y - rect.top) / height)));
  return { left: rect.left + col * width, top: rect.top + row * height, width, height, col, row };
}

/**
 * 机身放在尖端右下方；放不下时翻到左侧 / 上方，最后再限制在容器内。
 * flip 传入时沿用（拖动过程中不翻面，避免机身在手指下跳动）。
 */
export function layoutMouseBody(tip, bounds, { body = MOUSE_BODY, gap = POINTER_GAP, flip } = {}) {
  const flipX = flip ? flip.x : tip.x + gap.x + body.width > bounds.width;
  const flipY = flip ? flip.y : tip.y + gap.y + body.height > bounds.height;
  const left = flipX ? tip.x - gap.x - body.width : tip.x + gap.x;
  const top = flipY ? tip.y - gap.y - body.height : tip.y + gap.y;
  return {
    left: Math.max(0, Math.min(Math.max(0, bounds.width - body.width), left)),
    top: Math.max(0, Math.min(Math.max(0, bounds.height - body.height), top)),
    flip: { x: flipX, y: flipY },
  };
}

/**
 * 滑块长按识别：按下后计时，手指移动超过阈值即取消（视为普通拖动），抬起也取消。
 * 返回的 down / move / cancel 由滑块的指针事件调用；触发后 fired() 为真。
 */
export function createLongPress(view, onLongPress, { delay = LONG_PRESS_MS, slop = LONG_PRESS_SLOP } = {}) {
  let timer = null;
  let origin = null;
  let fired = false;
  function cancel() {
    view.clearTimeout(timer);
    timer = null;
    origin = null;
  }
  return {
    down(event) {
      cancel();
      fired = false;
      origin = { x: event.clientX, y: event.clientY };
      timer = view.setTimeout(() => {
        timer = null;
        origin = null;
        fired = true;
        onLongPress();
      }, delay);
    },
    move(event) {
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > slop) cancel();
    },
    cancel,
    fired: () => fired,
  };
}

const POINTER_PATH = 'M3 3 19.6 9.2 12.2 12.2 9.2 19.6Z';
const POINTER_SVG = `<svg aria-hidden="true" viewBox="0 0 22 22"><path class="virtual-mouse-pointer-outline" d="${POINTER_PATH}"></path><path class="virtual-mouse-pointer-fill" d="${POINTER_PATH}"></path></svg>`;

/**
 * host：终端外层容器（放胶囊、指针和虚拟鼠标）；target：接收点按的终端区域。
 * extraTargets：同样接收点按的其他区域（盖在终端上的历史面板）。
 * screenRect()：指针可活动的画面（client 坐标）；grid()：{ cols, rows }，返回空时不画字格高亮（历史面板没有字格）。
 * onClick(point, button)：左键 0 / 右键 2 点击；onDrag(phase, point)：按住左键拖动（down / move / up）。
 * position() / savePosition(ratio)：按会话记住指针位置；onChange(active)：进入 / 退出时通知。
 */
export function attachMouseMode(host, target, {
  onClick, onDrag, onChange, screenRect, grid, position, savePosition, extraTargets = [],
  label = 'Mouse', exitLabel = 'Exit mouse mode', leftLabel = 'Left click', rightLabel = 'Right click', dragLabel = 'Drag to move pointer',
} = {}) {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  const pill = doc.createElement('button');
  pill.type = 'button';
  pill.className = 'mouse-mode-pill';
  pill.hidden = true;
  pill.setAttribute('aria-label', exitLabel);
  pill.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="6"></rect><path d="M12 7v4"></path></svg><span></span><b aria-hidden="true">✕</b>';
  pill.querySelector('span').textContent = label;
  const marker = doc.createElement('div');
  marker.className = 'mouse-mode-marker';
  marker.hidden = true;
  const cell = doc.createElement('div');
  cell.className = 'virtual-mouse-cell';
  cell.hidden = true;
  const pointer = doc.createElement('div');
  pointer.className = 'virtual-mouse-pointer';
  pointer.hidden = true;
  pointer.innerHTML = POINTER_SVG;
  const body = doc.createElement('div');
  body.className = 'virtual-mouse';
  body.hidden = true;
  body.setAttribute('role', 'group');
  body.setAttribute('aria-label', dragLabel);
  body.innerHTML = '<button type="button" class="virtual-mouse-button" data-button="0"></button><button type="button" class="virtual-mouse-button" data-button="2"></button><span class="virtual-mouse-grip" aria-hidden="true"></span>';
  const [leftButton, rightButton] = body.querySelectorAll('button');
  leftButton.setAttribute('aria-label', leftLabel);
  rightButton.setAttribute('aria-label', rightLabel);
  const menu = doc.createElement('div');
  menu.className = 'virtual-mouse-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  host.append(cell, marker, pointer, body, menu, pill);

  let active = false;
  let press = null;
  let gesture = null;
  let markerTimer = null;
  let tip = null;
  let flip = null;
  let ratio = null;
  let disposed = false;
  let renderedScreen = null;
  let lastLeftClick = -Infinity;

  function fullRect() {
    return screenRect?.() ?? target.getBoundingClientRect();
  }

  function rect() {
    return visibleRect(fullRect(), host.getBoundingClientRect());
  }

  /** 按当前尖端位置摆放指针、字格高亮与机身。 */
  function render() {
    if (!active || !tip) return;
    const screen = rect();
    tip = clampPoint(tip, screen);
    renderedScreen = { left: screen.left, top: screen.top, width: screen.width, height: screen.height };
    const bounds = host.getBoundingClientRect();
    const local = { x: tip.x - bounds.left, y: tip.y - bounds.top };
    pointer.style.transform = `translate(${local.x - POINTER_TIP.x}px, ${local.y - POINTER_TIP.y}px)`;
    const size = grid?.();
    // 字格按完整画面计算：可见区域可能只是画面的一部分。
    const box = size && cellRect(tip, fullRect(), size.cols, size.rows);
    cell.hidden = !box;
    if (box) {
      cell.style.transform = `translate(${box.left - bounds.left}px, ${box.top - bounds.top}px)`;
      cell.style.width = box.width + 'px';
      cell.style.height = box.height + 'px';
    }
    const layout = layoutMouseBody(local, bounds, { flip: gesture ? flip : undefined });
    flip = layout.flip;
    body.style.transform = `translate(${layout.left}px, ${layout.top}px)`;
    if (!menu.hidden) placeMenu(layout);
  }

  function moveTo(point, save = true) {
    tip = clampPoint(point, rect());
    render();
    if (save) rememberPosition();
  }

  function rememberPosition() {
    ratio = toRatio(tip, renderedScreen ?? rect());
    savePosition?.({ ...ratio });
  }

  function hideMenu() {
    menu.hidden = true;
    menu.replaceChildren();
  }

  function placeMenu(layout) {
    const bounds = host.getBoundingClientRect();
    const width = menu.offsetWidth || 160;
    const height = menu.offsetHeight || 44;
    const left = Math.max(4, Math.min(bounds.width - width - 4, layout.left + MOUSE_BODY.width / 2 - width / 2));
    // 放在机身远离指针的一侧，不盖住指针和刚选中的文字；放不下再换到另一侧。
    const above = layout.top - height - 8;
    const below = layout.top + MOUSE_BODY.height + 8;
    const belowFits = below + height + 4 <= bounds.height;
    const useBelow = layout.flip.y ? above < 4 && belowFits : belowFits || above < 4;
    const top = Math.max(4, useBelow ? Math.min(bounds.height - height - 4, below) : above);
    menu.style.transform = `translate(${left}px, ${top}px)`;
  }

  /** 在虚拟鼠标附近弹出一排操作（普通终端右键用）；items：[{ label, run }]。 */
  function showMenu(items) {
    if (!active || !items?.length) return;
    menu.replaceChildren(...items.map(item => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (!active || disposed || menu.hidden || !menu.contains(button)) return;
        hideMenu();
        item.run();
      });
      return button;
    }));
    menu.hidden = false;
    render();
  }

  function set(value) {
    if (disposed) return;
    const next = !!value;
    if (next === active) return;
    active = next;
    pill.hidden = body.hidden = pointer.hidden = !active;
    host.classList.toggle('mouse-mode', active);
    if (active) {
      const screen = rect();
      ratio = position?.() ?? ratio ?? { x: .5, y: .5 };
      tip = fromRatio(ratio, screen);
      flip = null;
      render();
    } else {
      endGesture(true);
      press = null;
      lastLeftClick = -Infinity;
      view.clearTimeout(markerTimer);
      markerTimer = null;
      marker.hidden = cell.hidden = true;
      hideMenu();
    }
    onChange?.(active);
  }

  /** 在点击处闪一下标记，让用户看到实际点到的位置。 */
  function mark(point) {
    const bounds = host.getBoundingClientRect();
    marker.style.left = point.x - bounds.left + 'px';
    marker.style.top = point.y - bounds.top + 'px';
    marker.hidden = false;
    marker.classList.remove('pulse');
    void marker.offsetWidth;
    marker.classList.add('pulse');
    view.clearTimeout(markerTimer);
    markerTimer = view.setTimeout(() => { marker.hidden = true; }, 700);
  }

  // ---- 终端区域：点按只移动指针 ----
  function down(event) {
    if (!active || !event.isPrimary || event.button !== 0) { press = null; return; }
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, at: view.performance.now() };
  }
  function move(event) {
    if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP) press = null;
  }
  function up(event) {
    if (!active || !press || press.id !== event.pointerId) return;
    const start = press;
    press = null;
    if (!isTap(start, { x: event.clientX, y: event.clientY, at: view.performance.now() })) return;
    hideMenu();
    moveTo({ x: event.clientX, y: event.clientY });
  }
  const cancel = () => { press = null; };

  // ---- 虚拟鼠标：拖机身移动，点左右键点击，按住左键滑动即拖动 ----
  function endGesture(cancelled = false) {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    view.clearTimeout(current.timer);
    if (body.hasPointerCapture?.(current.id)) body.releasePointerCapture(current.id);
    body.classList.remove('dragging', 'holding');
    rememberPosition();
    if (current.mode === 'hold') onDrag?.('up', { ...tip });
    if (!cancelled && active) {
      render();
    }
  }

  function bodyDown(event) {
    if (!active || !event.isPrimary || gesture || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    hideMenu();
    const button = event.target.closest?.('.virtual-mouse-button');
    const which = button ? Number(button.dataset.button) : null;
    // 刚点过左键时，接下来拖机身算按住左键拖动（单击后再滑动选中）。
    const afterClick = view.performance.now() - lastLeftClick <= CLICK_DRAG_MS;
    lastLeftClick = -Infinity;
    gesture = {
      id: event.pointerId, button: which, mode: which === null && !afterClick ? 'drag' : 'pending',
      x: event.clientX, y: event.clientY, at: view.performance.now(), origin: { ...tip }, timer: null,
    };
    try { body.setPointerCapture(event.pointerId); } catch {}
    if (gesture.mode === 'drag') body.classList.add('dragging');
    if (which === 0) {
      gesture.timer = view.setTimeout(() => {
        if (!gesture || gesture.mode !== 'pending') return;
        gesture.mode = 'hold';
        body.classList.add('holding');
        mark(tip);
        onDrag?.('down', { ...tip });
      }, HOLD_MS);
    }
  }

  function bodyMove(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.mode === 'pending') {
      if (Math.hypot(dx, dy) <= TAP_SLOP) return;
      view.clearTimeout(gesture.timer);
      if (gesture.button === 2) {
        // 右键上直接拖动当作拖机身，免得手指必须对准下半部分。
        gesture.mode = 'drag';
        body.classList.add('dragging');
      } else {
        // 按着左键滑动就是按住左键拖动，不必先等长按。
        gesture.mode = 'hold';
        body.classList.add('holding');
        mark(gesture.origin);
        onDrag?.('down', { ...gesture.origin });
      }
    }
    moveTo({ x: gesture.origin.x + dx, y: gesture.origin.y + dy }, false);
    if (gesture?.mode === 'hold') onDrag?.('move', { ...tip });
  }

  function bodyUp(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const current = gesture;
    if (current.mode === 'pending' && current.button !== null && event.type === 'pointerup'
      && isTap(current, { x: event.clientX, y: event.clientY, at: view.performance.now() })) {
      endGesture();
      mark(tip);
      if (current.button === 0) lastLeftClick = view.performance.now();
      onClick?.({ ...tip }, current.button);
      return;
    }
    endGesture(event.type !== 'pointerup');
  }

  function outsideDown(event) {
    if (!active) return;
    if (gesture && gesture.id !== event.pointerId) endGesture(true);
    if (!event.isPrimary) cancel();
    if (!menu.contains(event.target) && !body.contains(event.target)) hideMenu();
  }

  function suspend() {
    cancel();
    lastLeftClick = -Infinity;
    endGesture(true);
    hideMenu();
  }

  function visibility() { if (doc.hidden) suspend(); }

  function bodyTouchMove(event) {
    if (!gesture) return;
    if (event.touches.length !== 1) { suspend(); return; }
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  }

  pill.addEventListener('click', event => { event.stopPropagation(); set(false); });
  for (const element of [pill, body, menu]) {
    for (const type of ['pointerdown', 'touchstart', 'mousedown']) element.addEventListener(type, event => event.stopPropagation());
  }
  // 点鼠标和菜单不能清掉历史面板里已选中的文字。
  for (const element of [body, menu]) element.addEventListener('mousedown', event => event.preventDefault());
  body.addEventListener('pointerdown', bodyDown);
  body.addEventListener('lostpointercapture', event => { if (gesture?.id === event.pointerId) endGesture(true); });
  body.addEventListener('contextmenu', event => event.preventDefault());
  // 键盘 / 读屏用户：按钮的 click（非指针触发，detail 为 0）也能点击。
  body.addEventListener('click', event => {
    const button = event.target.closest?.('.virtual-mouse-button');
    if (!button || event.detail !== 0 || !active) return;
    mark(tip);
    onClick?.({ ...tip }, Number(button.dataset.button));
  });
  const targets = [target, ...extraTargets];
  for (const element of targets) {
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', cancel, true);
  }
  doc.addEventListener('pointerdown', outsideDown, true);
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointermove', bodyMove);
  doc.addEventListener('pointerup', bodyUp);
  doc.addEventListener('pointercancel', bodyUp);
  doc.addEventListener('touchmove', bodyTouchMove, { capture: true, passive: false });
  doc.addEventListener('visibilitychange', visibility);
  view.addEventListener('blur', suspend);
  view.addEventListener('resize', refresh);
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => refresh()) : null;
  resize?.observe(host);

  /** 终端尺寸变化后按记住的比例重新摆放。 */
  function refresh() {
    if (!active) return;
    suspend();
    const saved = position?.() ?? ratio;
    if (saved) tip = fromRatio(saved, rect());
    render();
  }

  return {
    set,
    toggle: () => set(!active),
    isActive: () => active,
    showMenu,
    hideMenu,
    refresh,
    point: () => (tip ? { ...tip } : null),
    dispose() {
      if (disposed) return;
      set(false);
      disposed = true;
      resize?.disconnect();
      view.clearTimeout(markerTimer);
      for (const element of targets) {
        element.removeEventListener('pointerdown', down, true);
        element.removeEventListener('pointerup', up, true);
        element.removeEventListener('pointercancel', cancel, true);
      }
      doc.removeEventListener('pointerdown', outsideDown, true);
      doc.removeEventListener('pointermove', move, true);
      doc.removeEventListener('pointermove', bodyMove);
      doc.removeEventListener('pointerup', bodyUp);
      doc.removeEventListener('pointercancel', bodyUp);
      doc.removeEventListener('touchmove', bodyTouchMove, true);
      doc.removeEventListener('visibilitychange', visibility);
      view.removeEventListener('blur', suspend);
      view.removeEventListener('resize', refresh);
      for (const element of [pill, marker, cell, pointer, body, menu]) element.remove();
    },
  };
}
