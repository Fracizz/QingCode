// 只读历史面板的渲染：电脑端历史为带基本颜色的文本行，可见行从 xterm 缓冲区带颜色复制。
// 纯函数，不依赖全局状态，便于 Vitest 覆盖。

/** 旧版电脑端为全屏程序采样画面插入的标记行；新版不再采样，保留解析以兼容旧电脑端。 */
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

/** 把 xterm 的一行切成 { text, style } 段；宽字符的占位单元格跳过，默认去掉行尾空白。 */
export function lineSegments(line, cols, theme = {}, keepTrailing = false) {
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
  // 行尾空白（含无背景的空格）不保留，避免换行宽度不一致时多出一行；
  // 自动换行的行保留，行尾空格可能是单词间隔。
  while (!keepTrailing && segments.length) {
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

// 电脑端历史只含 SGR（`ESC [ … m`）；其他 ESC 一律丢弃，不当作控制序列执行。
const SGR = /\x1b\[([0-9;:]*)m/g;

/** 去掉 SGR 序列，得到纯文本。 */
export function stripSgr(line) {
  return line.replace(SGR, '').replace(/\x1b/g, '');
}

function sgrColor(params, index, theme) {
  const mode = Number(params[index + 1]);
  if (mode === 5) return { color: paletteColor(Number(params[index + 2]) & 255, theme), used: 2 };
  if (mode === 2) {
    const [r, g, b] = params.slice(index + 2, index + 5).map(value => Math.max(0, Math.min(255, Number(value) || 0)));
    return { color: `rgb(${r},${g},${b})`, used: 4 };
  }
  return { color: null, used: 0 };
}

const DEFAULT_STATE = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };

/** 按 SGR 参数更新样式；只支持颜色、粗体、暗色、斜体、下划线与反显。 */
function applySgr(state, text, theme) {
  const params = text === '' ? ['0'] : text.split(/[;:]/);
  for (let index = 0; index < params.length; index += 1) {
    const code = Number(params[index] || 0);
    if (code === 0) Object.assign(state, DEFAULT_STATE);
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 3) state.italic = true;
    else if (code === 23) state.italic = false;
    else if (code === 4) state.underline = true;
    else if (code === 24) state.underline = false;
    else if (code === 7) state.inverse = true;
    else if (code === 27) state.inverse = false;
    else if (code >= 30 && code <= 37) state.fg = paletteColor(code - 30, theme);
    else if (code >= 90 && code <= 97) state.fg = paletteColor(code - 90 + 8, theme);
    else if (code === 39) state.fg = null;
    else if (code >= 40 && code <= 47) state.bg = paletteColor(code - 40, theme);
    else if (code >= 100 && code <= 107) state.bg = paletteColor(code - 100 + 8, theme);
    else if (code === 49) state.bg = null;
    else if (code === 38 || code === 48) {
      const { color, used } = sgrColor(params, index, theme);
      state[code === 38 ? 'fg' : 'bg'] = color;
      index += used;
    }
  }
}

/** 一行带 SGR 的历史文本切成 { text, style } 段；每行都从默认样式开始。 */
export function sgrSegments(line, theme = {}) {
  const state = { ...DEFAULT_STATE };
  const segments = [];
  let position = 0;
  const push = text => {
    text = text.replace(/\x1b/g, '');
    if (!text) return;
    let { fg, bg } = state;
    if (state.inverse) [fg, bg] = [bg ?? theme.background ?? null, fg ?? theme.foreground ?? null];
    const style = { fg, bg, bold: state.bold, dim: state.dim, italic: state.italic, underline: state.underline };
    segments.push({ text, style: plainStyle(style) ? null : style });
  };
  for (const match of line.matchAll(SGR)) {
    push(line.slice(position, match.index));
    applySgr(state, match[1], theme);
    position = match.index + match[0].length;
  }
  push(line.slice(position));
  return segments;
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
  for (const raw of lines) {
    const line = stripSgr(raw);
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
    items.push({ kind: 'text', text: empty ? '' : line.replace(/\s+$/, ''), raw: empty ? '' : raw });
  }
  return items;
}

/** 电脑端历史一页渲染为片段（带颜色时按 SGR 着色）；textContent 仍是逐行文本，便于复制与阅读。 */
export function renderHistoryPage(doc, lines, theme = {}) {
  const fragment = doc.createDocumentFragment();
  let text = '';
  const flush = () => { if (text) { fragment.append(doc.createTextNode(text)); text = ''; } };
  for (const item of historyItems(lines)) {
    if (item.kind === 'divider') {
      flush();
      fragment.append(divider(doc, item.text));
    } else if (!item.raw.includes('\x1b')) {
      text += item.text + '\n';
    } else {
      flush();
      const segments = sgrSegments(item.raw, theme);
      // 与纯文本一致去掉行尾空白。
      const last = segments[segments.length - 1];
      if (last && !last.style?.bg) last.text = last.text.replace(/\s+$/, '');
      for (const segment of segments) if (segment.text) appendSegment(fragment, doc, segment);
      text = '\n';
    }
  }
  flush();
  return fragment;
}

/** 手机可见行带颜色复制，作为只读面板的起点；与上方电脑端历史连续衔接，不加分隔条。 */
export function renderScreen(doc, term) {
  const fragment = doc.createDocumentFragment();
  const buffer = term.buffer.active;
  const theme = term.options.theme ?? {};
  for (let index = 0; index < term.rows; index += 1) {
    const line = buffer.getLine(buffer.viewportY + index);
    // 下一行是自动换行的延续时拼成一个逻辑行，交给手机按自身宽度排版。
    const wrapsOnward = index < term.rows - 1 && !!buffer.getLine(buffer.viewportY + index + 1)?.isWrapped;
    for (const segment of lineSegments(line, term.cols, theme, wrapsOnward)) appendSegment(fragment, doc, segment);
    if (index < term.rows - 1 && !wrapsOnward) fragment.append(doc.createTextNode('\n'));
  }
  return fragment;
}
