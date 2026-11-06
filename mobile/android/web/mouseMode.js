// 终端「鼠标模式」：长按右侧滑块（或「… → 鼠标模式」）进入。
// 模式内拖滑块滚动；点终端时，普通终端选中手指下的词，开了鼠标上报的全屏程序收到一次鼠标点击，
// 并在点击处闪一个光标标记。点左下角胶囊、返回键、切换会话或离开终端时退出。

/** 按住滑块多久算长按，以及长按期间允许的手指抖动（px）。 */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 8;
/** 点按判定：位移与时长上限。 */
export const TAP_SLOP = 10;
export const TAP_MAX_MS = 500;

/** 判断一次按下 / 抬起是否算点按（纯函数，便于测试）。 */
export function isTap(start, end, slop = TAP_SLOP, maxMs = TAP_MAX_MS) {
  if (!start || !end) return false;
  return Math.hypot(end.x - start.x, end.y - start.y) <= slop && end.at - start.at <= maxMs;
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

/**
 * host：终端外层容器（放胶囊和点击标记）；target：接收点按的终端区域。
 * onTap({ x, y })：模式内点按终端；onChange(active)：进入 / 退出时通知。
 */
export function attachMouseMode(host, target, { onTap, onChange, label = 'Mouse', exitLabel = 'Exit mouse mode' } = {}) {
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
  host.append(pill, marker);
  let active = false;
  let press = null;
  let markerTimer = null;

  function set(value) {
    const next = !!value;
    if (next === active) return;
    active = next;
    pill.hidden = !active;
    host.classList.toggle('mouse-mode', active);
    if (!active) { press = null; marker.hidden = true; }
    onChange?.(active);
  }

  /** 在点击处闪一下光标标记，让用户看到实际点到的位置。 */
  function mark(x, y) {
    const bounds = host.getBoundingClientRect();
    marker.style.left = x - bounds.left + 'px';
    marker.style.top = y - bounds.top + 'px';
    marker.hidden = false;
    marker.classList.remove('pulse');
    void marker.offsetWidth;
    marker.classList.add('pulse');
    view.clearTimeout(markerTimer);
    markerTimer = view.setTimeout(() => { marker.hidden = true; }, 700);
  }

  function down(event) {
    if (!active || !event.isPrimary) { press = null; return; }
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, at: view.performance.now() };
  }
  function up(event) {
    if (!active || !press || press.id !== event.pointerId) return;
    const start = press;
    press = null;
    if (!isTap(start, { x: event.clientX, y: event.clientY, at: view.performance.now() })) return;
    mark(event.clientX, event.clientY);
    onTap?.({ x: event.clientX, y: event.clientY });
  }
  const cancel = () => { press = null; };
  pill.addEventListener('click', event => { event.stopPropagation(); set(false); });
  for (const type of ['pointerdown', 'touchstart', 'mousedown']) pill.addEventListener(type, event => event.stopPropagation());
  target.addEventListener('pointerdown', down, true);
  target.addEventListener('pointerup', up, true);
  target.addEventListener('pointercancel', cancel, true);

  return {
    set,
    toggle: () => set(!active),
    isActive: () => active,
    dispose() {
      set(false);
      view.clearTimeout(markerTimer);
      target.removeEventListener('pointerdown', down, true);
      target.removeEventListener('pointerup', up, true);
      target.removeEventListener('pointercancel', cancel, true);
      pill.remove();
      marker.remove();
    },
  };
}
