// 终端输出中的网页链接：识别 http / https 地址（实时终端与「阅读与搜索输出」共用），
// 把电脑上的 localhost 地址换成手机能访问的电脑局域网地址，并接入 xterm 的链接识别。
// 纯逻辑在前半部分，Vitest：src/lib/mobileAndroidTerminalLinks.test.ts。
import { t } from './i18n.js';

const LINK_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
// 句末标点和未配对的右括号不属于链接。
const TRAILING = /[.,;:!?，。；：！？、）)\]}>]+$/u;

/** 找出文本中的网页链接，返回 { start, end, url }（end 不含）。 */
export function findLinks(text) {
  const links = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    let url = match[0];
    // 链接自身包含成对括号时保留右括号，例如 Wikipedia 地址。
    while (TRAILING.test(url)) {
      const last = url.at(-1);
      if (last === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
      url = url.slice(0, -1);
    }
    if (!/^https?:\/\/[^/?#]+/.test(url)) continue;
    links.push({ start: match.index, end: match.index + url.length, url });
  }
  return links;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

/**
 * 手机上打开终端链接的方式。电脑上的 localhost 对手机指向手机自己：
 * 本机 / WSL 项目换成电脑地址（需要开发服务监听局域网）；远端 SSH 项目的 localhost 在远端主机上，只能复制。
 */
export function phoneLink(url, { computerHost = '', projectKind = 'local' } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { url, open: null, note: t('无法识别的链接，可复制后查看。') }; }
  if (!LOOPBACK.test(parsed.hostname)) return { url, open: url, note: '' };
  if (projectKind === 'ssh') {
    return { url, open: null, note: t('这是远端主机上的本地地址，手机无法直接访问。可复制后在远端或通过端口转发打开。') };
  }
  if (!computerHost) return { url, open: null, note: t('这是电脑上的本地地址，手机无法直接访问。') };
  parsed.hostname = computerHost;
  return {
    url,
    open: parsed.toString(),
    note: t('已换成电脑地址。开发服务需监听局域网（例如 --host 0.0.0.0）且电脑防火墙放行该端口，手机才能打开。'),
  };
}

/**
 * 读取 buffer 中 y 所在的整条逻辑行（含自动折行），返回文字和每个 UTF-16 单元对应的单元格。
 * 中文等宽字符占两列，按单元格映射保证链接范围与屏幕位置一致。
 */
export function logicalLine(buffer, y) {
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
  let last = y;
  while (buffer.getLine(last + 1)?.isWrapped) last += 1;
  let text = '';
  const cells = [];
  for (let row = first; row <= last; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      const width = cell?.getWidth() ?? 1;
      if (width === 0) continue;
      const chars = cell?.getChars() || ' ';
      for (let index = 0; index < chars.length; index += 1) cells.push({ x, y: row, width });
      text += chars;
    }
  }
  return { text, cells };
}

/** 逻辑行中的链接换算成 xterm 的 1 起始、两端包含的单元格范围。 */
export function lineLinks(buffer, y) {
  const { text, cells } = logicalLine(buffer, y);
  return findLinks(text).map(link => {
    const start = cells[link.start];
    const end = cells[link.end - 1];
    return {
      url: link.url,
      range: { start: { x: start.x + 1, y: start.y + 1 }, end: { x: end.x + end.width, y: end.y + 1 } },
    };
  });
}

/** 单元格（0 起始）是否落在链接范围内。 */
export function linkContains(range, x, y) {
  const cellX = x + 1;
  const cellY = y + 1;
  if (cellY < range.start.y || cellY > range.end.y) return false;
  if (cellY === range.start.y && cellX < range.start.x) return false;
  if (cellY === range.end.y && cellX > range.end.x) return false;
  return true;
}

/**
 * 注册 xterm 链接识别：鼠标悬停下划线、点按交给 onActivate(url)。
 * 返回 { dispose, linkAt(clientX, clientY) }，后者供全屏程序拦截鼠标时按触点坐标查找链接。
 */
export function attachTerminalLinks(term, { onActivate }) {
  const provider = term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const buffer = term.buffer.active;
      const links = lineLinks(buffer, lineNumber - 1)
        .filter(link => link.range.start.y <= lineNumber && link.range.end.y >= lineNumber)
        .map(link => ({
          range: link.range,
          text: link.url,
          decorations: { underline: true, pointerCursor: true },
          activate: (event, text) => {
            event?.preventDefault?.();
            onActivate(text);
          },
        }));
      callback(links.length ? links : undefined);
    },
  });
  function linkAt(clientX, clientY) {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen || !term.cols || !term.rows) return null;
    const box = screen.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
    const x = Math.min(term.cols - 1, Math.floor((clientX - box.left) / (box.width / term.cols)));
    const y = term.buffer.active.viewportY + Math.min(term.rows - 1, Math.floor((clientY - box.top) / (box.height / term.rows)));
    return lineLinks(term.buffer.active, y).find(link => linkContains(link.range, x, y))?.url ?? null;
  }
  return { dispose: () => provider.dispose(), linkAt };
}
