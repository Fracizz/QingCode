import { t } from './i18n.js';
import { formatTerminalQuote } from './protocol.js';
/**
 * Touch selection uses xterm's buffer/cell coordinates, including wide CJK cells.
 * canQuote：终端可写且程序开启了括号粘贴（Claude Code 等 AI CLI）时才显示「添加到对话」，
 * 否则多行引用会被逐行执行（普通 Shell 里 `> xxx` 还会变成重定向）。
 */
export function attachTerminalSelection({ term, container, copyText, onStart = () => {}, canQuote = () => false }) {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  const screen = term.element.querySelector('.xterm-screen');
  const layer = doc.createElement('div');
  layer.className = 'terminal-selection-layer';
  layer.hidden = true;
  const tools = doc.createElement('div');
  tools.className = 'terminal-selection-tools';
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', t('终端文字选择'));
  tools.hidden = true;
  const status = doc.createElement('span');
  status.setAttribute('role', 'status');
  const handles = ['start', 'end'].map(side => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'terminal-selection-handle';
    button.dataset.side = side;
    button.setAttribute('aria-label', side === 'start' ? t('调整选区起点') : t('调整选区终点'));
    layer.append(button);
    return button;
  });
  let active = false;
  let held = false;
  let drag = null;
  let virtualAnchor = null;
  let frame = null;
  let epoch = 0;
  let disposed = false;

  function index(position) { return position.y * term.cols + position.x; }
  function range() {
    const selected = term.getSelectionPosition();
    return selected ? [index(selected.start), index(selected.end)] : null;
  }
  function point(x, y, end = false) {
    const rect = screen.getBoundingClientRect();
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) * term.rows / rect.height)));
    let col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) * term.cols / rect.width)));
    const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
    if (col > 0 && line?.getCell(col)?.getWidth() === 0) col--;
    return (term.buffer.active.viewportY + row) * term.cols + col + (end ? Math.max(1, line?.getCell(col)?.getWidth() ?? 1) : 0);
  }
  function select(a, b) {
    const start = Math.max(0, Math.min(a, b));
    const end = Math.min(term.buffer.active.length * term.cols, Math.max(a, b));
    term.select(start % term.cols, Math.floor(start / term.cols), Math.max(1, end - start));
    position();
  }
  function position() {
    if (!active) return;
    const selected = term.getSelectionPosition();
    if (!selected) { close(); return; }
    const rect = screen.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    layer.style.left = rect.left - bounds.left + 'px';
    layer.style.top = rect.top - bounds.top + 'px';
    layer.style.width = rect.width + 'px';
    layer.style.height = rect.height + 'px';
    [selected.start, selected.end].forEach((p, i) => {
      const row = p.y - term.buffer.active.viewportY;
      handles[i].hidden = row < 0 || row >= term.rows;
      handles[i].style.left = Math.max(22, Math.min(rect.width - 22, p.x * rect.width / term.cols)) + 'px';
      handles[i].style.top = Math.max(0, Math.min(rect.height - 36, (row + 1) * rect.height / term.rows)) + 'px';
    });
  }
  function close() {
    if (!active) return false;
    active = held = false;
    drag = null;
    virtualAnchor = null;
    epoch++;
    view.cancelAnimationFrame(frame);
    frame = null;
    layer.hidden = tools.hidden = true;
    term.clearSelection();
    return true;
  }
  function start({ x, y }) {
    if (disposed) return;
    virtualAnchor = null;
    onStart();
    // Keep the existing keyboard focus: hiding the IME would resize/reflow the
    // terminal and immediately invalidate the selection we are about to make.
    const at = point(x, y);
    const row = Math.floor(at / term.cols);
    const line = term.buffer.active.getLine(row);
    let left = at % term.cols;
    let right = left + Math.max(1, line?.getCell(left)?.getWidth() ?? 1);
    const isText = col => {
      const cell = line?.getCell(col);
      return cell && (cell.getWidth() === 0 || /\S/u.test(cell.getChars()));
    };
    if (isText(left)) {
      while (left > 0 && isText(left - 1)) left--;
      while (right < term.cols && isText(right)) right++;
    }
    active = held = true;
    epoch++;
    status.textContent = '';
    quote.hidden = !canQuote();
    layer.hidden = tools.hidden = false;
    select(row * term.cols + left, row * term.cols + right);
  }
  function dragSelection(phase, location) {
    if (disposed) return;
    if (phase === 'down') {
      start(location);
      held = false;
      virtualAnchor = range()?.[0] ?? null;
    } else if (virtualAnchor !== null) {
      if (active) select(virtualAnchor, point(location.x, location.y, true));
      if (phase === 'up') virtualAnchor = null;
    }
  }
  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.textContent = t('复制');
  copy.addEventListener('click', async () => {
    const text = term.getSelection();
    if (!text || copy.disabled) return;
    const attempt = epoch;
    copy.disabled = true;
    try {
      await copyText(text);
      // 复制成功即退出选区；「已复制」提示交给调用方（工具栏随选区一起隐藏）。
      if (!disposed && attempt === epoch) close();
    } catch (error) {
      if (!disposed && attempt === epoch) status.textContent = t(t(error.message || '复制失败，请重试'));
    } finally { copy.disabled = false; }
  });
  const quote = doc.createElement('button');
  quote.type = 'button';
  quote.textContent = t('添加到对话');
  quote.hidden = true;
  quote.addEventListener('click', () => {
    // 点击时再校验一次：选区打开期间程序可能已退出或关闭括号粘贴。
    const text = formatTerminalQuote(term.getSelection());
    if (!text || !canQuote()) { quote.hidden = true; return; }
    close();
    term.paste(text);
  });
  const all = doc.createElement('button');
  all.type = 'button';
  all.textContent = t('全选');
  all.addEventListener('click', () => { term.selectAll(); position(); status.textContent = ''; });
  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = t('取消');
  dismiss.addEventListener('click', close);
  tools.append(copy, quote, all, dismiss, status);
  tools.addEventListener('pointerdown', event => event.preventDefault());
  container.append(layer, tools);

  function updateDrag() {
    if (!drag) return;
    const rect = screen.getBoundingClientRect();
    if (term.buffer.active.type === 'normal') {
      if (drag.y < rect.top + 20) term.scrollLines(-1);
      else if (drag.y > rect.bottom - 20) term.scrollLines(1);
    }
    select(drag.anchor, point(drag.x - drag.offsetX, drag.y - drag.offsetY, drag.side === 'end'));
  }
  function tick() {
    frame = null;
    if (!drag) return;
    updateDrag();
    frame = view.requestAnimationFrame(tick);
  }
  layer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const selected = range();
    if (!selected) return;
    const side = event.target.dataset.side ?? 'end';
    const p = term.getSelectionPosition()[side];
    const rect = screen.getBoundingClientRect();
    const handle = event.target.closest('.terminal-selection-handle');
    const offsetX = handle ? event.clientX - (rect.left + (p.x + (side === 'end' ? -.5 : .5)) * rect.width / term.cols) : 0;
    const offsetY = handle ? event.clientY - (rect.top + (p.y - term.buffer.active.viewportY + .5) * rect.height / term.rows) : 0;
    drag = { id: event.pointerId, anchor: selected[side === 'start' ? 1 : 0], side, x: event.clientX, y: event.clientY, offsetX, offsetY };
    held = false;
    status.textContent = '';
    layer.setPointerCapture(event.pointerId);
    if (frame === null) frame = view.requestAnimationFrame(tick);
  });
  layer.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    updateDrag();
  });
  function release(event) {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    view.cancelAnimationFrame(frame);
    frame = null;
  }
  layer.addEventListener('pointerup', release);
  layer.addEventListener('pointercancel', release);
  layer.addEventListener('lostpointercapture', release);
  function touchMove(event) {
    if (!active || !held || event.touches.length !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selected = range();
    if (selected) select(selected[0], point(event.touches[0].clientX, event.touches[0].clientY, true));
  }
  function touchEnd(event) {
    if (!active || !held) return;
    event.preventDefault();
    held = false;
  }
  function context(event) { event.preventDefault(); }
  container.addEventListener('touchmove', touchMove, { capture: true, passive: false });
  container.addEventListener('touchend', touchEnd, { capture: true, passive: false });
  screen.addEventListener('contextmenu', context);
  const subscriptions = [term.onScroll(position), term.onRender(position), term.onResize(close)];
  return {
    start, drag: dragSelection, close, isActive: () => active,
    dispose() {
      close();
      disposed = true;
      subscriptions.forEach(subscription => subscription.dispose());
      container.removeEventListener('touchmove', touchMove, true);
      container.removeEventListener('touchend', touchEnd, true);
      screen.removeEventListener('contextmenu', context);
      layer.remove();
      tools.remove();
    },
  };
}
