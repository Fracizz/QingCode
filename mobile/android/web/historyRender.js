// 只读历史面板的渲染：电脑端历史为带基本颜色的文本行，可见行从 xterm 缓冲区带颜色复制。
// 制表符、中文等字符按 xterm 字格宽度对齐，表格边框在历史里不错位、不折行。
// 纯函数，不依赖全局状态，便于 Vitest 覆盖。
import { t } from './i18n.js';

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

// 东亚宽字符与宽 emoji 占两格（与 xterm Unicode 11 宽度近似）；零宽字符不占格。
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f3fa],
  [0x1f400, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const ZERO = [
  [0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
];

function inRanges(ranges, cp) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cp < ranges[mid][0]) high = mid - 1;
    else if (cp > ranges[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
}

/** 一个码位在终端里占几格：0、1 或 2。 */
export function charCells(cp) {
  if (cp < 0x300) return 1;
  if (inRanges(ZERO, cp)) return 0;
  return inRanges(WIDE, cp) ? 2 : 1;
}

/** 可能不按等宽字格显示的字符（宽字符、制表符、符号等）；只有出现时才逐段对齐。 */
const NEEDS_GRID = /[\u1100-\u115f\u2000-\u{10ffff}]/u;

/**
 * 把文本切成 { text, cells } 段：cells 为 null 的是按字体等宽显示的普通字符；
 * 其余（制表符 ─│┼、中文、emoji 等）在 DOM 里的字形宽度与 xterm 字格不同，需固定为 cells 个字格宽。
 */
export function gridRuns(text) {
  const runs = [];
  let current = null;
  for (const char of text) {
    const cp = char.codePointAt(0);
    const cells = charCells(cp);
    const grid = cells === 2 || (cp >= 0x2000 && cells === 1);
    if (current && (cells === 0 || (current.cells !== null) === grid)) {
      current.text += char;
      if (current.cells !== null) current.cells += cells;
      continue;
    }
    runs.push(current = { text: char, cells: grid ? cells : null });
  }
  return runs;
}

/**
 * 用 canvas 量字形宽度（以 em 计），让对齐段内字形均匀铺满字格；量不到时返回 null，只固定段宽。
 * 依赖已加载的字体，每次渲染新建并缓存本次结果。
 */
export function createCellMeter(doc, fontFamily) {
  if (!doc?.fonts || !fontFamily) return null;
  let context = null;
  try { context = doc.createElement('canvas').getContext('2d'); } catch { return null; }
  if (!context) return null;
  context.font = `100px ${fontFamily}`;
  const cell = context.measureText('0').width / 100;
  if (!(cell > 0)) return null;
  const cache = new Map();
  return text => {
    let width = cache.get(text);
    if (width === undefined) cache.set(text, width = context.measureText(text).width / 100);
    return { cell, width };
  };
}

/** 对齐段：inline-block 固定为 cells 个字格（ch），再按测量结果用字距把字形铺匀。 */
function gridSpan(doc, run, meter) {
  const span = doc.createElement('span');
  span.className = 'cells';
  span.style.width = run.cells + 'ch';
  const glyphs = [...run.text].filter(char => charCells(char.codePointAt(0)) > 0).length;
  const measured = meter?.(run.text);
  if (measured && glyphs) {
    const spacing = (run.cells * measured.cell - measured.width) / glyphs;
    if (Math.abs(spacing) > 0.001) span.style.letterSpacing = spacing.toFixed(4) + 'em';
  }
  span.textContent = run.text;
  return span;
}

// 方块字符的四个象限（1 左上、2 右上、4 左下、8 右下）。字形比行高矮，按字体显示时行间有缝，
// 这里按字格绘制，字符本身保留在 DOM 里供复制。
const BLOCK_QUADRANTS = new Map([
  [0x2580, 3], [0x2584, 12], [0x2588, 15], [0x258c, 5], [0x2590, 10], [0x2596, 4], [0x2597, 8], [0x2598, 1],
  [0x2599, 13], [0x259a, 9], [0x259b, 7], [0x259c, 11], [0x259d, 2], [0x259e, 6], [0x259f, 14],
]);
const QUADRANT_POSITIONS = [[1, '0 0'], [2, '100% 0'], [4, '0 100%'], [8, '100% 100%']];

function blockCell(doc, char, quadrants) {
  const span = doc.createElement('span');
  span.className = 'block-cell';
  const positions = QUADRANT_POSITIONS.filter(([bit]) => quadrants & bit).map(([, position]) => position);
  span.style.backgroundImage = positions.map(() => 'linear-gradient(currentColor, currentColor)').join(', ');
  span.style.backgroundPosition = positions.join(', ');
  span.textContent = char;
  return span;
}

/** 对齐段里的方块字符逐格绘制，其余字符仍按段固定字格宽度。 */
function appendGridRun(parent, doc, run, meter) {
  let pending = '';
  let cells = 0;
  const flush = () => {
    if (pending) parent.append(gridSpan(doc, { text: pending, cells }, meter));
    pending = '';
    cells = 0;
  };
  for (const char of run.text) {
    const cp = char.codePointAt(0);
    const quadrants = BLOCK_QUADRANTS.get(cp);
    if (quadrants === undefined) { pending += char; cells += charCells(cp); continue; }
    flush();
    parent.append(blockCell(doc, char, quadrants));
  }
  flush();
}

function appendText(parent, doc, text, meter) {
  if (!NEEDS_GRID.test(text)) { parent.append(doc.createTextNode(text)); return; }
  for (const run of gridRuns(text)) {
    if (run.cells === null || run.cells === 0) parent.append(doc.createTextNode(run.text));
    else appendGridRun(parent, doc, run, meter);
  }
}

function appendSegment(parent, doc, segment, meter) {
  if (!segment.style) { appendText(parent, doc, segment.text, meter); return; }
  const span = doc.createElement('span');
  const { fg, bg, bold, dim, italic, underline } = segment.style;
  if (fg) span.style.color = fg;
  if (bg) span.style.backgroundColor = bg;
  if (bold) span.style.fontWeight = '700';
  if (dim) span.style.opacity = '0.6';
  if (italic) span.style.fontStyle = 'italic';
  if (underline) span.style.textDecoration = 'underline';
  appendText(span, doc, segment.text, meter);
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
      items.push({ kind: 'divider', text: t('全屏画面') });
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
export function renderHistoryPage(doc, lines, theme = {}, meter = null) {
  const fragment = doc.createDocumentFragment();
  let text = '';
  const flush = () => { if (text) { fragment.append(doc.createTextNode(text)); text = ''; } };
  for (const item of historyItems(lines)) {
    if (item.kind === 'divider') {
      flush();
      fragment.append(divider(doc, item.text));
    } else if (!item.raw.includes('\x1b') && !NEEDS_GRID.test(item.text)) {
      text += item.text + '\n';
    } else if (!item.raw.includes('\x1b')) {
      flush();
      appendText(fragment, doc, item.text, meter);
      text = '\n';
    } else {
      flush();
      const segments = sgrSegments(item.raw, theme);
      // 与纯文本一致去掉行尾空白。
      const last = segments[segments.length - 1];
      if (last && !last.style?.bg) last.text = last.text.replace(/\s+$/, '');
      for (const segment of segments) if (segment.text) appendSegment(fragment, doc, segment, meter);
      text = '\n';
    }
  }
  flush();
  return fragment;
}

/** 手机可见行带颜色复制，作为只读面板的起点；与上方电脑端历史连续衔接，不加分隔条。 */
export function renderScreen(doc, term, meter = null) {
  const fragment = doc.createDocumentFragment();
  const buffer = term.buffer.active;
  const theme = term.options.theme ?? {};
  for (let index = 0; index < term.rows; index += 1) {
    const line = buffer.getLine(buffer.viewportY + index);
    // 下一行是自动换行的延续时拼成一个逻辑行，交给手机按自身宽度排版。
    const wrapsOnward = index < term.rows - 1 && !!buffer.getLine(buffer.viewportY + index + 1)?.isWrapped;
    for (const segment of lineSegments(line, term.cols, theme, wrapsOnward)) appendSegment(fragment, doc, segment, meter);
    if (index < term.rows - 1 && !wrapsOnward) fragment.append(doc.createTextNode('\n'));
  }
  return fragment;
}
