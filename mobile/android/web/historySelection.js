// 虚拟鼠标在历史面板里选字：历史是普通 DOM 文本，没有 xterm 的字格，用浏览器的选区 API。

/** 文本里 offset 所在的连续非空白片段 [start, end)；落在空白上时只取当前一个字符。 */
export function wordRange(text, offset) {
  if (!text) return [0, 0];
  const at = Math.max(0, Math.min(text.length - 1, offset));
  if (!/\S/u.test(text[at])) return [at, at + 1];
  let start = at;
  let end = at + 1;
  while (start > 0 && /\S/u.test(text[start - 1])) start--;
  while (end < text.length && /\S/u.test(text[end])) end++;
  return [start, end];
}

export function attachHistorySelection(content) {
  const doc = content.ownerDocument;
  const view = doc.defaultView;
  let anchor = null;

  function caret({ x, y }) {
    const range = doc.caretRangeFromPoint?.(x, y);
    return range && content.contains(range.startContainer) ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  /** 选中指针下的词；指针不在文字上时返回 false。 */
  function start(point) {
    const at = caret(point);
    if (!at || at.node.nodeType !== 3) return false;
    const [from, to] = wordRange(at.node.textContent, at.offset);
    view.getSelection().setBaseAndExtent(at.node, from, at.node, to);
    return true;
  }

  /** 按住左键拖动：按下处为锚点，移动时把选区延伸到指针处。 */
  function drag(phase, point) {
    if (phase === 'down') {
      anchor = caret(point);
      if (anchor) view.getSelection().collapse(anchor.node, anchor.offset);
      return;
    }
    if (!anchor) return;
    const at = caret(point);
    if (at) view.getSelection().setBaseAndExtent(anchor.node, anchor.offset, at.node, at.offset);
    if (phase === 'up') anchor = null;
  }

  function text() {
    const selection = view.getSelection();
    return selection && !selection.isCollapsed && content.contains(selection.anchorNode) ? selection.toString() : '';
  }

  function clear() {
    anchor = null;
    if (text()) view.getSelection().removeAllRanges();
  }

  return { start, drag, text, clear };
}
