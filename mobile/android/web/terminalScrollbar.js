// 终端右侧的触摸滚动条：加粗、可直接拖动，长输出一下拖到顶。
// 滚动来源（xterm 本地记录或只读历史面板）由调用方通过 metrics / scrollTo 提供。

/** 滑块尺寸与位置（像素）：total / visible / offset 为同一单位的内容长度。 */
export function thumbGeometry({ total, visible, offset }, track, minSize = 48) {
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

export function attachTerminalScrollbar(host, { metrics, scrollTo, idleMs = 1500 } = {}) {
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
    if (atEnd && !drag) hideTimer = view.setTimeout(() => { if (!drag) bar.hidden = true; }, idleMs);
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
    bar.setPointerCapture?.(event.pointerId);
    if (!inside) moveTo(event.clientY);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    moveTo(event.clientY);
  }
  function up(event) {
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
    hide() { view.clearTimeout(hideTimer); drag = null; bar.classList.remove('dragging'); bar.hidden = true; },
    dragging: () => !!drag,
    dispose() { view.clearTimeout(hideTimer); bar.remove(); },
  };
}
