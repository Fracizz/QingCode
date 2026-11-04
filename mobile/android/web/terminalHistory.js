/** Paged history replaces the viewport while the live terminal keeps receiving output. */
export function attachTerminalHistory({ term, get, loadPage, onClose = () => {} }) {
  const panel = get('terminal-history');
  const scroll = get('history-scroll');
  const content = get('history-content');
  const moreButton = get('history-more');
  const latestButton = get('scroll-bottom');
  const status = get('history-status');
  const view = panel.ownerDocument.defaultView;
  let active = true;
  let generation = 0;
  let latest = 0;
  let available = false;
  let cursor = null;
  let startCursor = 0;
  let more = true;
  let loading = false;
  let failed = false;
  let departedBottom = false;
  let motionFrame = null;
  let motion = 0;
  let touchY = null;

  function atBottom() { return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2; }
  function selecting() {
    const selection = view.getSelection();
    return selection && !selection.isCollapsed && content.contains(selection.anchorNode);
  }

  function close() {
    if (panel.hidden) return false;
    generation += 1;
    panel.hidden = true;
    panel.setAttribute('aria-busy', 'false');
    loading = false;
    if (motionFrame !== null) view.cancelAnimationFrame(motionFrame);
    motionFrame = null;
    motion = 0;
    onClose();
    term.scrollToBottom();
    latestButton.hidden = true;
    return true;
  }

  function applyMotion() {
    motionFrame = null;
    if (panel.hidden) return;
    const delta = motion;
    motion = 0;
    if (delta > 0 && atBottom() && !loading) { close(); return; }
    const before = scroll.scrollTop;
    scroll.scrollTop += delta;
    const remainder = delta - (scroll.scrollTop - before);
    // Carry a fast drag across a page still in flight, rather than losing its distance.
    if (remainder < 0 && more) motion += remainder;
    if (scroll.scrollTop < Math.max(160, scroll.clientHeight) && !failed) void older();
  }

  function queueMotion(delta) {
    motion += delta;
    if (motionFrame === null) motionFrame = view.requestAnimationFrame(applyMotion);
  }

  async function older() {
    if (!active || panel.hidden || loading || !more) return;
    const attempt = generation;
    loading = true;
    failed = false;
    moreButton.disabled = true;
    moreButton.textContent = '正在加载历史…';
    panel.setAttribute('aria-busy', 'true');
    try {
      const page = await loadPage(cursor === null ? startCursor : cursor);
      if (!active || attempt !== generation) return;
      const height = scroll.scrollHeight;
      const top = scroll.scrollTop;
      const text = page.lines.length ? page.lines.join('\n') + '\n' : '';
      content.prepend(document.createTextNode(text));
      cursor = page.before;
      more = page.more === true;
      moreButton.hidden = !more;
      status.textContent = more ? '继续向上翻看历史' : page.truncated ? '更早输出已超出电脑端缓存' : '已到保留历史起点';
      scroll.scrollTop = top + scroll.scrollHeight - height;
      if (motion && motionFrame === null) motionFrame = view.requestAnimationFrame(applyMotion);
    } catch (error) {
      if (!active || attempt !== generation) return;
      failed = true;
      motion = 0;
      status.textContent = error.message;
    } finally {
      if (active && attempt === generation) {
        loading = false;
        moreButton.disabled = false;
        moreButton.textContent = failed ? '重试加载历史' : '加载更早输出';
        panel.setAttribute('aria-busy', 'false');
      }
    }
  }

  function open(delta) {
    if (!active || !available || !panel.hidden) return;
    generation += 1;
    const buffer = term.buffer.active;
    const localDepth = buffer.type === 'normal' ? buffer.baseY - buffer.viewportY : 0;
    startCursor = Math.max(0, latest - localDepth);
    // Copy the visible rows first: the first movement has no blank/loading-screen jump.
    const rows = Array.from({ length: term.rows }, (_, index) =>
      buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '');
    content.textContent = rows.join('\n');
    content.style.fontSize = term.options.fontSize + 'px';
    content.style.fontFamily = term.options.fontFamily;
    const screenHeight = term.element.querySelector('.xterm-screen').getBoundingClientRect().height;
    content.style.lineHeight = (screenHeight / term.rows) + 'px';
    cursor = null;
    more = true;
    failed = false;
    departedBottom = false;
    moreButton.hidden = false;
    panel.hidden = false;
    latestButton.hidden = false;
    status.textContent = '正在加载历史…';
    scroll.scrollTop = scroll.scrollHeight;
    queueMotion(delta);
    void older();
  }

  function onScroll() {
    if (selecting()) return;
    const distance = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
    if (distance > 32) departedBottom = true;
    if (departedBottom && atBottom() && !loading) { close(); return; }
    if (scroll.scrollTop < Math.max(160, scroll.clientHeight) && !failed) void older();
  }

  function onWheel(event) {
    if (!panel.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      queueMotion(event.deltaY);
      return;
    }
    if (event.deltaY >= 0 || !available) return;
    const ordinary = term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none';
    if ((!ordinary && !event.qingTouch) || (ordinary && term.buffer.active.viewportY > 0)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(event.deltaY);
  }

  function panelWheel(event) {
    if (selecting()) return;
    if (event.deltaY > 0 && atBottom() && !loading) { event.preventDefault(); close(); }
  }
  function touchStart(event) {
    onClose(); // Stop inertia from the preceding xterm gesture; native scrolling owns this one.
    if (motionFrame !== null) view.cancelAnimationFrame(motionFrame);
    motionFrame = null;
    motion = 0;
    touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
  }
  function touchMove(event) {
    if (selecting()) { touchY = null; return; }
    if (touchY === null || event.touches.length !== 1) { touchY = null; return; }
    const y = event.touches[0].clientY;
    if (y < touchY - 8 && atBottom() && !loading) { event.preventDefault(); close(); }
    touchY = y;
  }

  moreButton.addEventListener('click', older);
  scroll.addEventListener('scroll', onScroll);
  scroll.addEventListener('wheel', panelWheel, { passive: false });
  scroll.addEventListener('touchstart', touchStart, { passive: true });
  scroll.addEventListener('touchmove', touchMove, { passive: false });
  term.element.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return {
    close,
    isOpen: () => !panel.hidden,
    update(before, hasHistory) { latest = before ?? 0; available = hasHistory === true; },
    dispose() {
      active = false;
      close();
      content.textContent = '';
      moreButton.removeEventListener('click', older);
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('wheel', panelWheel);
      scroll.removeEventListener('touchstart', touchStart);
      scroll.removeEventListener('touchmove', touchMove);
      term.element.removeEventListener('wheel', onWheel, { capture: true });
    },
  };
}
