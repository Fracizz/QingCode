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
      notes: releaseNotes(localizeReleaseNotes(release.body, language)),
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
