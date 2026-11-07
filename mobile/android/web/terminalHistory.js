import { createCellMeter, renderHistoryPage, renderScreen } from './historyRender.js';
import { t } from './i18n.js';

/**
 * 手机本地滚动记录（可见区上方）相当于电脑端历史的多少行：电脑端把自动换行拼回一个逻辑行，
 * 本地的续行（isWrapped）不单独计数，否则接缝处会重复或缺行。
 */
export function localLogicalDepth(buffer) {
  if (buffer.type !== 'normal') return 0;
  let depth = 0;
  for (let index = buffer.viewportY; index < buffer.baseY; index += 1) {
    if (!buffer.getLine(index)?.isWrapped) depth += 1;
  }
  return depth;
}

/**
 * 上滑即原始终端：普通终端滚手机 xterm 的滚动记录，滑到顶后接电脑端保留的更早输出（只读面板）；
 * 全屏程序开启鼠标时滚轮交给程序自己滚动。
 */
export function attachTerminalHistory({ term, get, loadPage, onClose = () => {}, onUnsupportedScroll = () => {} }) {
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

  /** 字形测量器与终端同字体；每页新建，字体切换或加载完成后自动生效。 */
  const meter = () => createCellMeter(panel.ownerDocument, term.options.fontFamily);

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
    onClose();
    term.scrollToBottom();
    latestButton.hidden = true;
    latestButton.querySelector('span').textContent = t('回到最新');
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
    moreButton.textContent = t('正在加载历史…');
    panel.setAttribute('aria-busy', 'true');
    try {
      const page = await loadPage(cursor === null ? startCursor : cursor);
      if (!active || attempt !== generation) return;
      const height = scroll.scrollHeight;
      const top = scroll.scrollTop;
      content.prepend(renderHistoryPage(content.ownerDocument, page.lines, term.options.theme ?? {}, meter()));
      cursor = page.before;
      more = page.more === true;
      moreButton.hidden = !more;
      status.textContent = more ? t('继续向上翻看历史') : page.truncated ? t('更早输出已超出电脑端缓存') : t('已到保留历史起点');
      scroll.scrollTop = top + scroll.scrollHeight - height;
      rememberAnchor();
      if (motion && motionFrame === null) motionFrame = view.requestAnimationFrame(applyMotion);
    } catch (error) {
      if (!active || attempt !== generation) return;
      failed = true;
      motion = 0;
      status.textContent = t(error.message);
    } finally {
      if (active && attempt === generation) {
        loading = false;
        moreButton.disabled = false;
        moreButton.textContent = failed ? t('重试加载历史') : t('加载更早输出');
        panel.setAttribute('aria-busy', 'false');
      }
    }
  }

  function open(delta) {
    if (!active || !available || !panel.hidden) return;
    generation += 1;
    startCursor = Math.max(0, latest - localLogicalDepth(term.buffer.active));
    // 先带颜色复制可见行：第一次滑动不会出现空白或加载画面的跳变。
    content.replaceChildren(renderScreen(content.ownerDocument, term, meter()));
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
    status.textContent = t('正在加载历史…');
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
      queueMotion(event.deltaY);
      return;
    }
    const buffer = term.buffer.active;
    // 全屏程序没有开启鼠标时，xterm 会把滚轮转成方向键（Codex 里会翻出输入历史），手指滑动不发给程序。
    if (event.qingTouch && buffer.type === 'alternate' && term.modes.mouseTrackingMode === 'none') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.deltaY && !event.qingMomentum) onUnsupportedScroll(event.qingGesture);
      return;
    }
    // 其余情况交给 xterm：开了鼠标的程序收到滚轮，普通终端滚本地记录；只在本地记录到顶后接电脑端历史。
    if (event.deltaY >= 0 || !available) return;
    if (buffer.type !== 'normal' || term.modes.mouseTrackingMode !== 'none' || buffer.viewportY > 0) return;
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
