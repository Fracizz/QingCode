/** Paged history replaces the viewport while the live terminal keeps receiving output. */
export function attachTerminalHistory({ term, get, loadPage, onClose = () => {}, touchToProgram = () => false }) {
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
  let anchor = null;
  let restoringAnchor = false;
  let anchorFrame = null;
  let openingGesture = null;

  function rememberAnchor() {
    if (panel.hidden) { anchor = null; return; }
    const bounds = scroll.getBoundingClientRect();
    const doc = panel.ownerDocument;
    const range = doc.caretRangeFromPoint?.(bounds.left + 18, bounds.top + Math.min(20, bounds.height / 2));
    if (!range || !content.contains(range.startContainer)) { anchor = null; return; }
    if (range.startContainer.nodeType === 3 && range.startOffset < range.startContainer.textContent.length) {
      range.setEnd(range.startContainer, range.startOffset + 1);
    }
    anchor = { range, top: range.getBoundingClientRect().top - bounds.top };
  }
  const resizeObserver = new view.ResizeObserver(() => {
    if (panel.hidden || !anchor || !content.contains(anchor.range.startContainer) || selecting()) return;
    const delta = anchor.range.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 1) return;
    restoringAnchor = true;
    scroll.scrollTop += delta;
    if (anchorFrame !== null) view.cancelAnimationFrame(anchorFrame);
    anchorFrame = view.requestAnimationFrame(() => { anchorFrame = null; restoringAnchor = false; rememberAnchor(); });
  });
  resizeObserver.observe(scroll);

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
    openingGesture = null;
    onClose();
    term.scrollToBottom();
    latestButton.hidden = true;
    latestButton.querySelector('span').textContent = '回到最新';
    anchor = null;
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
      rememberAnchor();
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

  function open(delta, allowEmpty = false) {
    if (!active || (!available && !allowEmpty) || !panel.hidden) return;
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
    more = available;
    failed = false;
    departedBottom = false;
    moreButton.hidden = !more;
    panel.hidden = false;
    latestButton.hidden = false;
    status.textContent = available ? '正在加载历史…' : '暂无更早的已保留输出，当前画面可只读查看。';
    scroll.scrollTop = scroll.scrollHeight;
    queueMotion(delta);
    void older();
  }

  function onScroll() {
    if (restoringAnchor) return;
    rememberAnchor();
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
      const direction = event.qingTouch && openingGesture && openingGesture.id === event.qingGesture ? openingGesture.direction : 1;
      queueMotion(event.deltaY * direction);
      return;
    }
    const ordinary = term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none';
    // 全屏程序（Codex / OpenCode 等）默认不把手指滑动发给程序，防止误触改变程序界面：
    // 两个竖滑方向均可进入只读历史；进入的整次手势继续向历史移动，不能刚打开就退回实时。
    // 「触摸发给程序」开启时沿用原行为，实体鼠标不改变。
    if (event.qingTouch && !ordinary && !touchToProgram()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.deltaY && !event.qingMomentum) {
        openingGesture = event.qingGesture === undefined ? null : { id: event.qingGesture, direction: event.deltaY > 0 ? -1 : 1 };
        open(-Math.abs(event.deltaY), true);
      }
      return;
    }
    if (event.deltaY >= 0 || !available) return;
    if (!ordinary || term.buffer.active.viewportY > 0) return;
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
      resizeObserver.disconnect();
      if (anchorFrame !== null) view.cancelAnimationFrame(anchorFrame);
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
