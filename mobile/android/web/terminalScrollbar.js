// 终端右侧的触摸滚动条：加粗、可直接拖动，长输出一下拖到顶。
// 滚动来源（xterm 本地记录或只读历史面板）由调用方通过 metrics / scrollTo 提供。
// 按住滑块不动约半秒触发 onLongPress（进入鼠标模式）；鼠标模式下 setPinned(true) 让滑块常驻。
import { createLongPress } from './mouseMode.js';

/** 滑块尺寸与位置（像素）：total / visible / offset 为同一单位的内容长度。 */
/** 滑块最短高度：手指容易按住。 */
export const MIN_THUMB = 64;

export function thumbGeometry({ total, visible, offset }, track, minSize = MIN_THUMB) {
  if (!(total > visible) || !(track > 0)) return null;
  const size = Math.min(track, Math.max(minSize, track * visible / total));
  const range = total - visible;
  const ratio = Math.min(1, Math.max(0, offset / range));
  return { size, top: (track - size) * ratio };
}

/** 滑块顶部位置换算回滚动偏移。 */
export function offsetForThumb({ total, visible }, track, size, top) {
  const free = track - size;
  if (free <= 0) return 0;
  return Math.min(1, Math.max(0, top / free)) * (total - visible);
}

export function attachTerminalScrollbar(host, { metrics, scrollTo, onLongPress, idleMs = 1500 } = {}) {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  const bar = doc.createElement('div');
  bar.className = 'touch-scrollbar';
  bar.hidden = true;
  bar.setAttribute('aria-hidden', 'true');
  const thumb = doc.createElement('div');
  thumb.className = 'touch-scrollbar-thumb';
  bar.append(thumb);
  host.append(bar);
  let drag = null;
  let hideTimer = null;
  let current = null;
  let pinned = false;
  const longPress = createLongPress(view, () => {
    // 长按不是拖动：放开抓取，交给调用方切换鼠标模式。
    drag = null;
    bar.classList.remove('dragging');
    onLongPress?.();
    update();
  });

  function layout() {
    current = metrics();
    const geometry = current && thumbGeometry(current, bar.clientHeight || host.clientHeight);
    if (!geometry) { bar.hidden = true; return null; }
    thumb.style.height = geometry.size + 'px';
    thumb.style.transform = `translateY(${geometry.top}px)`;
    return geometry;
  }

  /** 内容滚动或增长时调用：离开底部时常驻，回到底部后短暂显示再隐藏。 */
  function update() {
    view.clearTimeout(hideTimer);
    hideTimer = null;
    const geometry = layout();
    if (!geometry) return;
    bar.hidden = false;
    const atEnd = current.offset >= current.total - current.visible - 1;
    if (atEnd && !drag && !pinned) hideTimer = view.setTimeout(() => { if (!drag && !pinned) bar.hidden = true; }, idleMs);
  }

  function moveTo(clientY) {
    if (!current) return;
    const track = bar.clientHeight;
    const geometry = thumbGeometry(current, track);
    if (!geometry) return;
    const rect = bar.getBoundingClientRect();
    scrollTo(offsetForThumb(current, track, geometry.size, clientY - rect.top - drag.grab));
  }

  function down(event) {
    if (bar.hidden || !layout()) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = thumb.getBoundingClientRect();
    const inside = event.clientY >= rect.top && event.clientY <= rect.bottom;
    // 按住滑块保持抓取点；点在轨道上则滑块中心跳到手指处。
    drag = { id: event.pointerId, grab: inside ? event.clientY - rect.top : rect.height / 2 };
    bar.classList.add('dragging');
    try {
      bar.setPointerCapture?.(event.pointerId);
    } catch {
      // 合成事件或指针已抬起时无法捕获。
    }
    if (onLongPress && inside) longPress.down(event);
    if (!inside) moveTo(event.clientY);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    longPress.move(event);
    moveTo(event.clientY);
  }
  function up(event) {
    longPress.cancel();
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    bar.classList.remove('dragging');
    update();
  }
  // 不让滚动条上的触摸落到终端手势（滑动、长按选择、双指缩放）。
  const stop = event => event.stopPropagation();

  bar.addEventListener('pointerdown', down);
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
  bar.addEventListener('touchstart', stop, { passive: true });
  bar.addEventListener('touchmove', stop, { passive: true });
  return {
    update,
    hide() { view.clearTimeout(hideTimer); longPress.cancel(); drag = null; bar.classList.remove('dragging'); bar.hidden = true; },
    /** 鼠标模式：常驻显示并换成强调色。 */
    setPinned(value) {
      pinned = !!value;
      bar.classList.toggle('pinned', pinned);
      update();
    },
    dragging: () => !!drag,
    dispose() { view.clearTimeout(hideTimer); longPress.cancel(); bar.remove(); },
  };
}
