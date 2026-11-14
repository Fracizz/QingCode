// 项目文件浏览的无 DOM 状态：路径、按电脑/项目保存位置与下载大小提示。
import { t } from './i18n.js';

export const LARGE_FILE_BYTES = 100 * 1024 * 1024;

export function relativeFilePath(value) {
  if (typeof value !== 'string' || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\\') || value.includes('\0')) return '';
  const parts = value.split('/').filter(Boolean);
  return parts.some(part => part === '.' || part === '..') ? '' : parts.join('/');
}

export function parentDirectory(value) {
  return relativeFilePath(value).split('/').slice(0, -1).join('/');
}

export function formatFileBytes(value) {
  if (!Number.isFinite(value) || value < 0) return t('大小未知');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return (unit ? value.toFixed(value < 10 ? 1 : 0) : String(value)) + ' ' + units[unit];
}

export function needsDownloadConfirmation(size) {
  return !Number.isFinite(size) || size < 0 || size >= LARGE_FILE_BYTES;
}

export function createFilePositions(storage) {
  const key = (host, project) => 'qingcode:mobile:files:' + host + ':' + project;
  return {
    read(host, project) {
      try {
        const saved = JSON.parse(storage.getItem(key(host, project)));
        return { path: relativeFilePath(saved?.path), scroll: Number.isFinite(saved?.scroll) ? Math.max(0, saved.scroll) : 0 };
      } catch { return { path: '', scroll: 0 }; }
    },
    write(host, project, path, scroll) {
      try { storage.setItem(key(host, project), JSON.stringify({ path: relativeFilePath(path), scroll: Math.max(0, scroll || 0) })); }
      catch { /* 阅读位置保存失败不阻止浏览。 */ }
    },
  };
}

/** 取消或切换目录后，让旧列表和查询结果失效。 */
export function createFileRequestScope() {
  let epoch = 0;
  return { begin: () => ++epoch, cancel: () => { epoch += 1; }, current: value => value === epoch };
}
