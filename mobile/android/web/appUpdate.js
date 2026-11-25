// 手机端在线更新的纯逻辑：从 GitHub / Gitee 发布列表中挑选比当前版本新的 Android 安装包。
// 版本号换算与 scripts/android-version.mjs 一致；不访问 DOM，Vitest：src/lib/mobileAndroidUpdate.test.ts。
import { locale, t } from './i18n.js';

export const UPDATE_PREFS_KEY = 'qingcode:mobile:update';
export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const CHANNELS = { alpha: 0, beta: 300, rc: 600 };
const STABLE = 999;
const MAX_NOTES = 4000;

/** major.minor.patch[-channel.n] → Android versionCode；格式不对时返回 null。 */
export function androidVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(String(version ?? '').trim().replace(/^v/i, ''));
  if (!match) return null;
  const [, major, minor, patch, channel, serial] = match;
  const [maj, min, pat] = [major, minor, patch].map(Number);
  if (maj > 209 || min > 99 || pat > 99) return null;
  const pre = channel ? CHANNELS[channel] + Number(serial) : STABLE;
  if (channel && Number(serial) > 299) return null;
  return maj * 10_000_000 + min * 100_000 + pat * 1_000 + pre;
}

export function isPrerelease(version) {
  return /-(alpha|beta|rc)\.\d+$/.test(String(version ?? ''));
}

export const apkAssetName = version => `QingCode_${version}-android.apk`;

/** 与原生层白名单一致：只从 github.com / gitee.com 的发布附件下载。 */
export function isAllowedApkUrl(url, version) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443')
    && ['github.com', 'gitee.com'].includes(parsed.hostname.toLowerCase())
    && parsed.pathname.includes('/releases/download/')
    && parsed.pathname.endsWith('/' + apkAssetName(version));
}

const LANGUAGE_HEADING = /^#{1,6}[ \t]+(English|中文)[ \t]*#*[ \t]*$/gm;
const LANGUAGE_NAV = /Language\s*\/\s*语言/i;
const NOTE_JUNK = /^\s*$|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$|^\s*<a\s+id=(['"])[^'"]*\1\s*>\s*<\/a>\s*$/i;

/** 去掉首尾的空行、分隔线和空 HTML 锚点。 */
function trimNoteSeparators(text) {
  const lines = text.split('\n');
  while (lines.length && NOTE_JUNK.test(lines[0])) lines.shift();
  while (lines.length && NOTE_JUNK.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

/**
 * 双语发布说明（`### English` / `### 中文`）只保留当前界面语言那一节；非双语正文原样返回。
 * 与桌面端 src/lib/releaseNotes.ts 保持一致。
 */
export function localizeReleaseNotes(body, language) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n');
  const headings = [...text.matchAll(LANGUAGE_HEADING)];
  const english = headings.find(match => match[1] === 'English');
  const chinese = headings.find(match => match[1] === '中文');
  if (!english || !chinese) return text;
  const wanted = /^zh(?:$|[-_])/i.test(String(language ?? '')) ? chinese : english;
  const other = wanted === chinese ? english : chinese;
  const end = other.index > wanted.index ? other.index : text.length;
  const section = trimNoteSeparators(text.slice(wanted.index + wanted[0].length, end));
  const prelude = trimNoteSeparators(text.slice(0, Math.min(english.index, chinese.index))
    .split('\n').filter(line => !LANGUAGE_NAV.test(line)).join('\n'));
  return [prelude, section].filter(Boolean).join('\n\n');
}

const DOWNLOAD_HEADING = /^(#{1,6})[ \t]+(?:下载|Downloads?)[ \t]*#*[ \t]*$/i;
const RELEASE_TITLE = /^#{1,6}[ \t]+QingCode[ \t]+v?\d/i;

/**
 * 手机端用不到电脑安装包清单：去掉「下载 / Downloads」小节（到同级或更高级标题为止），
 * 以及与弹窗版本行重复的 `## QingCode vX` 标题。
 */
export function mobileReleaseNotes(body) {
  const kept = [];
  let skipLevel = 0;
  let fenced = false;
  for (const line of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const level = fenced ? 0 : /^(#{1,6})[ \t]/.exec(line)?.[1].length ?? 0;
    if (skipLevel) {
      if (!level || level > skipLevel) continue;
      skipLevel = 0;
    }
    const download = level ? DOWNLOAD_HEADING.exec(line) : null;
    if (download) { skipLevel = download[1].length; continue; }
    if (level && RELEASE_TITLE.test(line)) continue;
    kept.push(line);
  }
  return trimNoteSeparators(kept.join('\n').replace(/\n{3,}/g, '\n\n'));
}

const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;
const LIST_ITEM = /^(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const CJK_END = /[\u3000-\u9fff\uff00-\uffef]$/;
const CJK_START = /^[\u3000-\u9fff\uff00-\uffef]/;

/**
 * 把发布说明的常用 Markdown 拆成块（标题、段落、列表、代码），界面再用 DOM 节点渲染，不经 innerHTML。
 * 表格每行折成一条「单元格 · 单元格」列表项；分隔线、空锚点忽略。
 */
export function noteBlocks(text) {
  const blocks = [];
  let paragraph = null;
  let list = null;
  let code = null;
  for (const raw of String(text ?? '').split('\n')) {
    if (code) {
      if (/^\s*```/.test(raw)) code = null;
      else code.text += (code.text ? '\n' : '') + raw;
      continue;
    }
    if (/^\s*```/.test(raw)) {
      paragraph = list = null;
      code = { type: 'code', text: '' };
      blocks.push(code);
      continue;
    }
    const line = raw.trim().replace(/^>\s?/, '');
    if (NOTE_JUNK.test(line)) { paragraph = list = null; continue; }
    let match = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(line);
    if (match) {
      paragraph = list = null;
      blocks.push({ type: 'heading', level: match[1].length, text: match[2] });
      continue;
    }
    if (TABLE_RULE.test(line)) continue;
    let item = null;
    let ordered = false;
    if (line.startsWith('|')) {
      item = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()).filter(Boolean).join(' · ');
    } else if ((match = LIST_ITEM.exec(line))) {
      item = match[3];
      ordered = !match[1];
    }
    if (item !== null) {
      paragraph = null;
      if (!list || list.ordered !== ordered) {
        list = { type: 'list', ordered, items: [] };
        blocks.push(list);
      }
      list.items.push(item);
      continue;
    }
    // 列表项下缩进的续行并入上一项。
    if (list && /^\s/.test(raw)) {
      list.items[list.items.length - 1] += joinLine(list.items[list.items.length - 1], line);
      continue;
    }
    list = null;
    if (paragraph) paragraph.text += joinLine(paragraph.text, line);
    else blocks.push(paragraph = { type: 'paragraph', text: line });
  }
  return blocks.filter(block => block.type !== 'code' || block.text);
}

/** 续行：中文相接不加空格，其余补一个空格。 */
function joinLine(before, after) {
  return CJK_END.test(before) && CJK_START.test(after) ? after : ' ' + after;
}

/** 行内标记拆成片段：`代码`、**粗体**；[文字](链接) 与 HTML 标签只保留文字。 */
export function noteInline(text) {
  const parts = [];
  const source = String(text ?? '').replace(/<\/?[a-z][^>]*>/gi, '');
  let last = 0;
  for (const match of source.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)]*\)/g)) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    if (match[1] != null) parts.push({ text: match[1], code: true });
    else if (match[2] != null) parts.push({ text: match[2], strong: true });
    else parts.push({ text: match[3] });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}

/** 发布说明只显示纯文本，去掉回车并限制长度。 */
export function releaseNotes(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  return text.length > MAX_NOTES ? text.slice(0, MAX_NOTES).trimEnd() + '\n…' : text;
}

/**
 * 选出版本号最高且高于当前版本的安装包。beta 等预发布版本的手机也能收到预发布更新；
 * 正式版手机只接收正式版，除非 includePrerelease 为真。
 */
export function pickApkUpdate(list, current, { includePrerelease = isPrerelease(current?.name), language = locale() } = {}) {
  const currentCode = Number(current?.code) || 0;
  let best = null;
  for (const release of Array.isArray(list?.releases) ? list.releases : []) {
    if (!release || release.draft) continue;
    const version = String(release.tag ?? '').trim().replace(/^v/i, '');
    const code = androidVersionCode(version);
    if (!code || code <= currentCode) continue;
    const prerelease = !!release.prerelease || isPrerelease(version);
    if (prerelease && !includePrerelease) continue;
    const asset = (Array.isArray(release.assets) ? release.assets : [])
      .find(item => item?.name === apkAssetName(version) && isAllowedApkUrl(item.url, version));
    if (!asset || (best && code <= best.code)) continue;
    best = {
      version, code, prerelease,
      url: asset.url,
      size: Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : null,
      notes: releaseNotes(mobileReleaseNotes(localizeReleaseNotes(release.body, language))),
      page: typeof release.page === 'string' ? release.page : list.page ?? null,
      source: list.source ?? null,
    };
  }
  return best;
}

export function parseUpdatePrefs(raw) {
  let saved;
  try { saved = JSON.parse(raw ?? 'null'); } catch { saved = null; }
  return {
    auto: saved?.auto !== false,
    lastCheck: Number.isFinite(saved?.lastCheck) ? saved.lastCheck : 0,
    skipped: typeof saved?.skipped === 'string' && saved.skipped ? saved.skipped : null,
  };
}

/** 自动检查每 24 小时最多一次；时钟回拨时立即允许。 */
export function shouldAutoCheck(prefs, now = Date.now()) {
  return prefs.auto && (now - prefs.lastCheck >= UPDATE_CHECK_INTERVAL || now < prefs.lastCheck);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 下载进度文案：有总长度时显示百分比。 */
export function progressText(received, total) {
  if (Number.isFinite(total) && total > 0) {
    const percent = Math.min(100, Math.floor(received / total * 100));
    return t('正在下载 {percent}% · {received} / {total}', { percent, received: formatBytes(received), total: formatBytes(total) });
  }
  return t('正在下载 {received}', { received: formatBytes(received) });
}
