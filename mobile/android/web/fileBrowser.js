// 项目文件列表、名称/路径查询与单文件下载；弹层覆盖终端，保持会话和草稿。
import { button, confirmAction, get, icon, rowText } from './dom.js';
import { dateLocale, locale, t } from './i18n.js';
import { createFilePositions, createFileRequestScope, folderDirection, formatFileBytes, needsDownloadConfirmation, parentDirectory, readFileSort, relativeFilePath, sortFileEntries, writeFileSort } from './fileBrowserState.js';

export function createFileBrowser({ rpc, capabilities, profile, beforeOpen = () => {} }) {
  const dialog = get('files-dialog');
  const detail = get('file-detail-dialog');
  const list = get('files-list');
  const positions = createFilePositions(localStorage);
  const requests = createFileRequestScope();
  const scrolls = new Map();
  let context = null;
  let path = '';
  let supported = false;
  let timer;
  let listAbort = null;
  let detailAbort = null;
  let entries = [];
  let selected = null;
  let selectionEpoch = 0;
  let transfer = null;
  let starting = false;
  let sortOrder = readFileSort(localStorage);

  const searching = () => !!get('files-query').value.trim();
  const activeTransfer = () => ['preparing', 'downloading'].includes(transfer?.state);
  const currentContext = target => dialog.open && target === context;

  function invalidate() {
    requests.cancel();
    listAbort?.abort();
    listAbort = null;
  }

  function savePosition() {
    if (!context || !supported || listAbort || searching()) return;
    const scroll = get('files-scroll').scrollTop;
    scrolls.set(path, scroll);
    positions.write(context.host.id, context.project.id, path, scroll);
  }

  function crumbs() {
    const nav = get('files-breadcrumbs');
    const root = button('text-button', () => navigate(''));
    root.textContent = context.project.name;
    const nodes = [root];
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? current + '/' + part : part;
      const target = current;
      const control = button('text-button', () => navigate(target));
      control.textContent = part;
      nodes.push(document.createTextNode(' / '), control);
    }
    nodes[nodes.length - 1].setAttribute('aria-current', 'location');
    nav.replaceChildren(...nodes);
    get('files-up').disabled = !path;
  }

  function renderTransfer() {
    get('files-transfer').hidden = !transfer;
    get('file-download').disabled = !selected || starting || activeTransfer();
    if (!transfer) return;
    const name = transfer.name || t('文件');
    get('files-transfer-name').textContent = [transfer.hostName, transfer.projectName, name].filter(Boolean).join(' / ');
    const received = Number.isFinite(transfer.received) ? transfer.received : 0;
    const total = transfer.total;
    const progress = get('files-progress');
    if (Number.isFinite(total) && total > 0) { progress.max = total; progress.value = Math.min(received, total); }
    else progress.removeAttribute('value');
    progress.hidden = transfer.state !== 'downloading';
    get('files-transfer-status').textContent = {
      preparing: t('正在准备下载…'),
      downloading: t('已下载 {received} / {total}', { received: formatFileBytes(received), total: formatFileBytes(total) }),
      done: t('下载完成'), canceled: t(transfer.message || '已取消下载。'), error: t(transfer.message || '下载失败，请检查网络后重试。'),
    }[transfer.state] || '';
    get('files-transfer-location').textContent = transfer.location ? t('保存位置：{location}', { location: transfer.location }) : '';
    get('files-transfer-location').hidden = !transfer.location;
    get('files-transfer-status').dataset.error = String(transfer.state === 'error');
    get('files-download-cancel').hidden = !activeTransfer();
    get('files-background-tip').hidden = !activeTransfer();
  }

  function receiveTransfer(event) {
    if (!Number.isSafeInteger(event?.revision) || (transfer && event.revision <= transfer.revision)) return;
    transfer = event;
    renderTransfer();
  }

  async function syncTransfer() {
    try { receiveTransfer(await rpc('file_download_status')); }
    catch { /* Keep the last status when the bridge is unavailable. */ }
  }

  function renderSort() {
    const control = get('files-sort');
    control.dataset.order = sortOrder;
    control.setAttribute('aria-label', t(sortOrder === 'asc' ? '按修改时间排序：旧的在前' : '按修改时间排序：新的在前'));
  }

  function toggleSort() {
    sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    writeFileSort(localStorage, sortOrder);
    renderSort();
    entries = sortFileEntries(entries, sortOrder);
    renderEntries();
    get('files-scroll').scrollTop = 0;
  }

  function renderEntries() {
    const query = searching();
    if (!entries.length) get('files-count').textContent = '';
    list.replaceChildren(...entries.map(entry => {
      const wrapper = document.createElement('div');
      wrapper.className = 'file-entry';
      const control = button('row', () => entry.isDir ? navigate(entry.path) : showFile(entry));
      control.dataset.path = entry.path;
      const date = Number.isFinite(entry.modifiedAt) ? new Date(entry.modifiedAt).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) : '';
      // 文件夹图标已表达类型，副标题只放修改时间；读屏仍读出「文件夹」。
      const meta = [entry.isDir ? '' : formatFileBytes(entry.size), date].filter(Boolean).join(' · ');
      const text = rowText(entry.name, meta);
      if (entry.isDir) control.setAttribute('aria-label', [entry.name, t('文件夹'), date].filter(Boolean).join(', '));
      control.dataset.entry = entry.isDir ? 'dir' : 'file';
      if (query) {
        const location = document.createElement('small');
        location.className = 'file-entry-path';
        location.textContent = entry.path;
        text.append(location);
      }
      const tile = document.createElement('span');
      tile.className = 'file-tile';
      tile.append(icon(entry.isDir ? 'folder' : 'file'));
      control.append(tile, text, icon(entry.isDir ? 'chevron' : 'down', 'arrow'));
      wrapper.append(control);
      if (query) {
        const locate = button('icon-button file-locate', () => navigate(parentDirectory(entry.path), entry.path));
        locate.setAttribute('aria-label', t('定位 {name}', { name: entry.name }));
        locate.append(icon('folder'));
        wrapper.append(locate);
      }
      return wrapper;
    }));
  }

  function setLoading(value) {
    list.setAttribute('aria-busy', String(value));
    get('files-refresh').disabled = !supported;
    get('files-cancel-query').hidden = !value || !searching();
  }

  async function load({ restore = null, highlight = null, slide = null } = {}) {
    clearTimeout(timer);
    if (!context || !supported || !dialog.open) return;
    const target = context;
    invalidate();
    const request = requests.begin();
    const controller = new AbortController();
    listAbort = controller;
    const query = get('files-query').value.trim();
    const args = { profile: target.host.id, project: target.project.id, path: query && get('files-scope').value === 'project' ? '' : path, hidden: get('files-hidden').checked };
    // 用静态占位行接住列表高度，避免新目录的面包屑下露出旧目录的交互项。
    list.style.setProperty('--file-loading-rows', String(Math.min(6, entries.length || 4)));
    delete list.dataset.slide;
    entries = [];
    setLoading(true);
    renderEntries();
    if (slide) get('files-scroll').scrollTop = 0;
    get('files-count').textContent = '';
    get('files-status').textContent = t(query ? '正在查询文件…' : '正在读取目录…');
    get('files-status').dataset.error = 'false';
    get('files-truncated').hidden = true;
    try {
      const result = await rpc(query ? 'file_search' : 'file_list', { ...args, ...(query ? { query } : {}) }, { signal: controller.signal });
      if (!currentContext(target) || !requests.current(request)) return;
      entries = sortFileEntries(Array.isArray(result.entries) ? result.entries : [], sortOrder);
      renderEntries();
      if (slide) slideList(slide);
      // 有结果时数量放在面包屑条右侧，状态行只留给加载、空目录和错误。
      get('files-count').textContent = entries.length ? t('{n} 项', { n: entries.length }) : '';
      get('files-status').textContent = entries.length ? '' : t(query ? '没有匹配的文件' : '此目录为空');
      get('files-truncated').hidden = !result.truncated;
      get('files-truncated').textContent = t(query ? '查询结果可能不完整（最多 200 条），请缩小查询范围。' : '目录未完整显示（最多 2000 项），可缩小范围查询。');
      get('files-rules').textContent = t('列表与查询遵循电脑端 files.exclude；不跟随符号链接。')
        + (result.excludeGitIgnore ? ' ' + t('同时遵循 .gitignore。') : '')
        + (Array.isArray(result.excludedPatterns) && result.excludedPatterns.length ? '\n' + result.excludedPatterns.join(', ') : '');
      if (restore !== null) get('files-scroll').scrollTop = restore;
      else get('files-scroll').scrollTop = 0;
      if (highlight) {
        const row = [...get('files-list').querySelectorAll('[data-path]')].find(item => item.dataset.path === highlight);
        row?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'center' });
      }
    } catch (error) {
      if (!currentContext(target) || !requests.current(request)) return;
      get('files-status').textContent = t(error.message);
      get('files-status').dataset.error = 'true';
    } finally {
      if (currentContext(target) && requests.current(request)) setLoading(false);
      if (listAbort === controller) listAbort = null;
    }
  }

  // 新目录内容到达后按层级方向轻移淡入（见 app.css #files-list[data-slide]）；先移除再写回属性，同方向连续进入也会重播。
  function slideList(direction) {
    void list.offsetWidth;
    list.dataset.slide = direction;
  }

  function navigate(next, highlight = null) {
    savePosition();
    invalidate();
    const slide = folderDirection(path, next);
    path = relativeFilePath(next);
    get('files-query').value = '';
    crumbs();
    void load({ restore: scrolls.get(path) || 0, highlight, slide });
  }

  function cancelQuery() {
    clearTimeout(timer);
    invalidate();
    setLoading(false);
    get('files-status').textContent = t('已取消查询');
  }

  function queueQuery() {
    savePosition();
    invalidate();
    clearTimeout(timer);
    entries = [];
    list.style.removeProperty('--file-loading-rows');
    delete list.dataset.slide;
    setLoading(true);
    renderEntries();
    setLoading(false);
    timer = setTimeout(() => load({ restore: searching() ? 0 : scrolls.get(path) || 0 }), 300);
  }

  async function showFile(entry) {
    const target = context;
    const epoch = ++selectionEpoch;
    detailAbort?.abort();
    const controller = new AbortController();
    detailAbort = controller;
    selected = null;
    get('file-detail-name').textContent = entry.name;
    get('file-detail-path').textContent = entry.path;
    get('file-detail-size').textContent = formatFileBytes(entry.size);
    get('file-detail-modified').textContent = Number.isFinite(entry.modifiedAt) ? new Date(entry.modifiedAt).toLocaleString(dateLocale()) : t('未知');
    get('file-detail-error').textContent = '';
    get('file-download-location').textContent = t('正在读取下载位置…');
    get('file-download').disabled = true;
    get('file-detail-loading').hidden = false;
    detail.showModal();
    void rpc('file_download_location').then(location => {
      if (detail.open && epoch === selectionEpoch) get('file-download-location').textContent = typeof location === 'string' ? location : t('无法读取下载位置。');
    }).catch(() => {
      if (detail.open && epoch === selectionEpoch) get('file-download-location').textContent = t('无法读取下载位置。');
    });
    try {
      const stat = await rpc('file_stat', { profile: target.host.id, project: target.project.id, path: entry.path }, { signal: controller.signal });
      if (!currentContext(target) || !detail.open || epoch !== selectionEpoch) return;
      if (stat.path !== entry.path || stat.name !== entry.name) throw new Error(t('文件信息发生变化，请刷新后重试。'));
      selected = stat;
      get('file-detail-size').textContent = formatFileBytes(stat.size);
      get('file-detail-modified').textContent = Number.isFinite(stat.modifiedAt) ? new Date(stat.modifiedAt).toLocaleString(dateLocale()) : t('未知');
      renderTransfer();
    } catch (error) {
      if (epoch === selectionEpoch && detail.open) get('file-detail-error').textContent = t(error.message);
    } finally {
      if (epoch === selectionEpoch) get('file-detail-loading').hidden = true;
      if (detailAbort === controller) detailAbort = null;
    }
  }

  async function download() {
    if (!selected || starting || activeTransfer()) return;
    const file = selected;
    const target = context;
    const epoch = selectionEpoch;
    try {
      if (needsDownloadConfirmation(file.size)) {
        const text = Number.isFinite(file.size) && file.size >= 0
          ? t('文件大小为 {size}，下载可能耗时较长。请确认手机有足够的存储空间。', { size: formatFileBytes(file.size) })
          : t('文件大小未知。请确认手机有足够的存储空间。');
        if (!await confirmAction(t('下载提醒'), text, t('继续下载'))) return;
      }
      if (!currentContext(target) || !detail.open || epoch !== selectionEpoch || starting || activeTransfer()) return;
      starting = true;
      get('file-detail-error').textContent = '';
      renderTransfer();
      receiveTransfer(await rpc('file_download', {
        profile: target.host.id, project: target.project.id, projectName: target.project.name,
        path: file.path, version: file.version, english: locale() === 'en',
      }));
      if (detail.open && epoch === selectionEpoch) detail.close();
    } catch (error) {
      if (detail.open && epoch === selectionEpoch) get('file-detail-error').textContent = t(error.message);
      void syncTransfer();
    } finally {
      starting = false;
      renderTransfer();
    }
  }

  async function open(item) {
    const host = profile();
    if (!host || !item) return;
    beforeOpen();
    if (dialog.open) { savePosition(); dialog.close(); }
    invalidate();
    context = { host: { ...host }, project: { ...item } };
    const target = context;
    const saved = positions.read(host.id, item.id);
    path = saved.path;
    scrolls.clear();
    scrolls.set(path, saved.scroll);
    supported = false;
    get('files-context').textContent = host.name + ' / ' + item.name;
    get('files-query').value = '';
    get('files-hidden').checked = false;
    get('files-scope').value = 'project';
    get('files-rules').textContent = t('列表与查询遵循电脑端 files.exclude；不跟随符号链接。');
    get('files-status').textContent = t('正在读取目录…');
    get('files-status').dataset.error = 'false';
    get('files-count').textContent = '';
    get('files-truncated').hidden = true;
    entries = [];
    renderEntries();
    crumbs();
    renderSort();
    renderTransfer();
    dialog.showModal();
    try {
      const info = await capabilities(host);
      if (!currentContext(target)) return;
      if (!info?.features.includes('project_files')) throw new Error(t('电脑端不支持项目文件，请更新电脑端 QingCode。'));
      supported = true;
      await load({ restore: saved.scroll });
    } catch (error) {
      if (currentContext(target)) {
        setLoading(false);
        get('files-status').textContent = t(error.message);
        get('files-status').dataset.error = 'true';
      }
    }
  }

  function back() {
    if (!dialog.open) return false;
    if (searching()) { get('files-query').value = ''; invalidate(); void load({ restore: scrolls.get(path) || 0 }); }
    else if (path) navigate(parentDirectory(path));
    else dialog.close();
    return true;
  }

  get('files-back').addEventListener('click', back);
  get('files-up').addEventListener('click', () => navigate(parentDirectory(path)));
  get('files-refresh').addEventListener('click', () => { savePosition(); void load({ restore: searching() ? 0 : scrolls.get(path) || 0 }); });
  get('files-query').addEventListener('input', queueQuery);
  get('files-scroll').addEventListener('scroll', savePosition, { passive: true });
  get('files-clear').addEventListener('click', () => { get('files-query').value = ''; queueQuery(); });
  get('files-cancel-query').addEventListener('click', cancelQuery);
  get('files-scope').addEventListener('change', queueQuery);
  get('files-hidden').addEventListener('change', queueQuery);
  get('files-sort').addEventListener('click', toggleSort);
  get('file-download').addEventListener('click', download);
  get('files-download-cancel').addEventListener('click', async () => {
    if (!activeTransfer()) return;
    try { await rpc('file_download_cancel', { id: transfer.id }); }
    catch (error) { get('files-transfer-status').textContent = t(error.message); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); back(); });
  dialog.addEventListener('close', () => { savePosition(); clearTimeout(timer); invalidate(); setLoading(false); selectionEpoch += 1; if (detail.open) detail.close(); });
  detail.addEventListener('close', () => { selectionEpoch += 1; selected = null; detailAbort?.abort(); detailAbort = null; });
  window.qingFileDownload = receiveTransfer;
  return { open, back, syncTransfer, isOpen: () => dialog.open, render: () => { if (dialog.open) { renderSort(); renderEntries(); renderTransfer(); } } };
}
