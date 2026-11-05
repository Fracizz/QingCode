// 只读历史面板的渲染：电脑端历史为纯文本行，当前画面从 xterm 缓冲区带颜色复制。
// 纯函数，不依赖全局状态，便于 Vitest 覆盖。

/** 电脑端为全屏程序（Codex / OpenCode 等）采样的画面之间插入的标记行，见 mobile_screen.rs。 */
export const TUI_FRAME_MARKER = '── 全屏画面历史 ──';

const BASE16 = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/** xterm 256 色调色板索引转 CSS 颜色；0-15 取主题色。 */
export function paletteColor(index, theme = {}) {
  if (index < 16) return theme[BASE16[index]] ?? null;
  if (index < 232) {
    const value = index - 16;
    const step = n => (n === 0 ? 0 : 55 + n * 40);
    return `rgb(${step(Math.floor(value / 36))},${step(Math.floor(value / 6) % 6)},${step(value % 6)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function cellColor(cell, kind, theme) {
  const is = name => cell[`is${kind}${name}`]?.();
  if (is('Default')) return null;
  const value = cell[`get${kind}Color`]();
  if (is('RGB')) return '#' + value.toString(16).padStart(6, '0');
  if (is('Palette')) return paletteColor(value, theme);
  return null;
}

/** 一个单元格的样式；相同样式的相邻单元格合并成一段。 */
function cellStyle(cell, theme) {
  let fg = cellColor(cell, 'Fg', theme);
  let bg = cellColor(cell, 'Bg', theme);
  if (cell.isInverse?.()) [fg, bg] = [bg ?? theme.background ?? null, fg ?? theme.foreground ?? null];
  return {
    fg, bg,
    bold: !!cell.isBold?.(),
    dim: !!cell.isDim?.(),
    italic: !!cell.isItalic?.(),
    underline: !!cell.isUnderline?.(),
  };
}

function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline;
}

function plainStyle(style) {
  return !style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline;
}

/** 把 xterm 的一行切成 { text, style } 段；去掉行尾空白，宽字符的占位单元格跳过。 */
export function lineSegments(line, cols, theme = {}) {
  if (!line) return [];
  if (typeof line.getCell !== 'function') {
    const text = line.translateToString(true);
    return text ? [{ text, style: null }] : [];
  }
  const segments = [];
  let current = null;
  let reuse; // xterm 允许复用同一个单元格对象，避免逐格分配
  for (let x = 0; x < cols; x += 1) {
    reuse = line.getCell(x, reuse);
    if (!reuse || reuse.getWidth() === 0) continue;
    const style = cellStyle(reuse, theme);
    const text = reuse.getChars() || ' ';
    if (current && sameStyle(current.style, style)) current.text += text;
    else segments.push(current = { text, style });
  }
  // 行尾空白（含无背景的空格）不保留，避免换行宽度不一致时多出一行。
  while (segments.length) {
    const last = segments[segments.length - 1];
    if (last.style.bg) break;
    last.text = last.text.replace(/\s+$/, '');
    if (last.text) break;
    segments.pop();
  }
  return segments.map(segment => ({ text: segment.text, style: plainStyle(segment.style) ? null : segment.style }));
}

function appendSegment(parent, doc, segment) {
  if (!segment.style) { parent.append(doc.createTextNode(segment.text)); return; }
  const span = doc.createElement('span');
  const { fg, bg, bold, dim, italic, underline } = segment.style;
  if (fg) span.style.color = fg;
  if (bg) span.style.backgroundColor = bg;
  if (bold) span.style.fontWeight = '700';
  if (dim) span.style.opacity = '0.6';
  if (italic) span.style.fontStyle = 'italic';
  if (underline) span.style.textDecoration = 'underline';
  span.textContent = segment.text;
  parent.append(span);
}

function divider(doc, label) {
  const element = doc.createElement('span');
  element.className = 'history-divider';
  element.textContent = label;
  return element;
}

/**
 * 整理电脑端的纯文本历史：连续空行折叠为一行，全屏画面标记变为分隔条。
 * 返回 { kind: 'text' | 'divider', text } 列表，text 不含换行。
 */
export function historyItems(lines) {
  const items = [];
  let blank = false;
  for (const line of lines) {
    if (line === TUI_FRAME_MARKER) {
      // 分隔条自带间距，去掉它前面的空行。
      if (items.length && items[items.length - 1].kind === 'text' && !items[items.length - 1].text.trim()) items.pop();
      items.push({ kind: 'divider', text: '全屏画面' });
      blank = true;
      continue;
    }
    const empty = !line.trim();
    if (empty && blank) continue;
    blank = empty;
    items.push({ kind: 'text', text: empty ? '' : line.replace(/\s+$/, '') });
  }
  return items;
}

/** 电脑端历史一页渲染为片段；textContent 仍是逐行文本，便于复制与阅读。 */
export function renderHistoryPage(doc, lines) {
  const fragment = doc.createDocumentFragment();
  let text = '';
  const flush = () => { if (text) { fragment.append(doc.createTextNode(text)); text = ''; } };
  for (const item of historyItems(lines)) {
    if (item.kind === 'divider') {
      flush();
      fragment.append(divider(doc, item.text));
    } else {
      text += item.text + '\n';
    }
  }
  flush();
  return fragment;
}

/** 当前画面（xterm 可见行）带颜色复制，开头用分隔条与更早历史区分。 */
export function renderScreen(doc, term) {
  const fragment = doc.createDocumentFragment();
  const buffer = term.buffer.active;
  const theme = term.options.theme ?? {};
  fragment.append(divider(doc, '当前画面'));
  for (let index = 0; index < term.rows; index += 1) {
    const line = buffer.getLine(buffer.viewportY + index);
    for (const segment of lineSegments(line, term.cols, theme)) appendSegment(fragment, doc, segment);
    if (index < term.rows - 1) fragment.append(doc.createTextNode('\n'));
  }
  return fragment;
}
