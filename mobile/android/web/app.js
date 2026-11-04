import {
  DEFAULT_PORT,
  applyModifiers,
  keySequence,
  matchesProject,
  outputChunk,
  parsePairingLink,
  projectSourceLabel,
  renameProfileKeys,
  splitInput,
  validIpv4,
  validPort,
} from './protocol.js';
import { decodeScannerFrame, focusScannerCamera, requestScannerCamera } from './scanner.js';
import { attachTerminalTouchScroll } from './terminalTouch.js';

const get = id => document.getElementById(id);
const native = window.QingCodeNative;
const pages = { home: get('home-screen'), project: get('project-screen'), connection: get('connection-screen') };
const terminalScreen = get('terminal-screen');
const compose = get('compose');
const requests = new Map();
const health = new Map();
const drafts = new Map();
const prefix = 'qingcode:mobile:';
let requestId = 0;
let profiles = [];
let profile = null;
let project = null;
let projects = [];
let loaded = false;
let profileEpoch = 0;
let page = 'home';
let kind = 'all';
let sessions = [];
let selected = null;
let viewEpoch = 0;
let term;
let fit;
let disposeTouchScroll;
let terminalReady = false;
const modifiers = { ctrl: false, alt: false };
let busy = false;
let inputQueue = '';
let inputTimer = null;
let inputChain = Promise.resolve();
let queuedInput = 0;
let resizing = null;
let editing = null;
let composing = false;
// Fingerprint from a scanned or pasted pairing link; skips manual comparison when it matches.
let expectedFingerprint = null;
let scanStream = null;
let scanTimer = null;
let scanEpoch = 0;
const savedFontSize = Number(localStorage.getItem(prefix + 'font-size'));
let terminalFontSize = Number.isInteger(savedFontSize) && savedFontSize >= 11 && savedFontSize <= 20 ? savedFontSize : 13;

function rpc(op, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    requests.set(id, { resolve, reject });
    try {
      native.request(id, JSON.stringify({ op, ...args }));
    } catch (error) {
      requests.delete(id);
      reject(error);
    }
  });
}

window.qingReply = (id, result) => {
  const request = requests.get(id);
  if (!request) return;
  requests.delete(id);
  if (result.ok) {
    request.resolve(result.data);
  } else {
    const error = new Error(result.error || '连接失败。');
    error.revoked = result.revoked === true;
    request.reject(error);
  }
};

function remote(op, args = {}, address = profile?.id) {
  return rpc(op, { ...args, profile: address });
}

function message(id, value) {
  const target = get(id);
  target.textContent = value;
  target.hidden = !value;
}

function showPage(next) {
  page = next;
  terminalScreen.hidden = true;
  get('dashboard').hidden = false;
  for (const [name, section] of Object.entries(pages)) section.hidden = name !== next;
  for (const button of get('dashboard-nav').querySelectorAll('button')) {
    if (button.dataset.page === next) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function returnToDashboard(next = page) {
  localStorage.removeItem(prefix + 'open');
  leaveTerminal();
  showPage(next);
}

window.qingBack = () => {
  for (const id of ['scan-dialog', 'confirm-dialog', 'pair-confirm', 'host-dialog', 'pair-dialog', 'session-dialog']) {
    const dialog = get(id);
    if (!dialog.open) continue;
    if (id !== 'pair-dialog' || !get('pair-submit').disabled) dialog.close('cancel');
    return true;
  }
  if (!terminalScreen.hidden) {
    returnToDashboard();
    return true;
  }
  if (page !== 'home') {
    showPage('home');
    return true;
  }
  return false;
};

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => get(button.dataset.close).close('cancel'));
}

// A backdrop tap cancels only when both ends of the gesture are outside the panel.
for (const dialog of document.querySelectorAll('dialog')) {
  let backdropDown = false;
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  dialog.addEventListener('pointerdown', event => { backdropDown = outside(event); });
  dialog.addEventListener('pointerup', event => {
    if (backdropDown && outside(event) && (dialog.id !== 'pair-dialog' || !get('pair-submit').disabled)) dialog.close('cancel');
    backdropDown = false;
  });
}

function ask(dialog) {
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function confirmAction(title, description, action) {
  get('confirm-title').textContent = title;
  get('confirm-text').textContent = description;
  get('confirm-action').textContent = action;
  return ask(get('confirm-dialog'));
}

function icon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.append(use);
  return svg;
}

function rowText(title, subtitle) {
  const text = document.createElement('span');
  text.className = 'row-text';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = subtitle;
  text.append(strong, small);
  return text;
}

function tile(name) {
  const element = document.createElement('span');
  element.className = 'tile';
  element.append(icon(name));
  return element;
}

function button(className, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.addEventListener('click', action);
  return element;
}

function hostState(item) {
  return health.get(item?.id) ?? 'saved';
}

function renderConnections() {
  const list = get('connection-list');
  list.replaceChildren();
  get('connection-empty').hidden = profiles.length > 0;
  for (const item of [...profiles].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id))) {
    const current = item.id === profile?.id;
    const state = hostState(item);
    const labels = { saved: '已配对', checking: '连接中…', online: '已连接', offline: '连接失败', expired: '需要重新配对' };
    const card = document.createElement('div');
    card.className = 'connection-card';
    card.dataset.current = String(current);
    card.dataset.state = state === 'expired' ? 'offline' : state;
    const select = button('connection-main', () => {
      if (state === 'expired') openPair(item);
      else void activate(item, current ? 'connection' : 'home');
    });
    const detail = button('icon-button', () => openHost(item));
    detail.setAttribute('aria-label', '管理连接 ' + item.name);
    detail.append(icon('more'));
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = rowText(item.name, item.id);
    const status = document.createElement('small');
    status.className = 'connection-state';
    status.textContent = labels[state] + (current ? ' · 当前电脑' : '');
    text.append(status);
    select.append(tile('host'), text, dot);
    card.append(select, detail);
    list.append(card);
  }
  get('active-host-name').textContent = profile?.name ?? '未连接';
  const state = hostState(profile);
  get('active-host').dataset.state = state === 'expired' ? 'offline' : state;
  get('active-host').setAttribute('aria-label', profile ? '切换连接，当前为 ' + profile.name : '管理连接');
}

function sessionKey(projectId) {
  return prefix + 'session:' + profile.id + ':' + projectId;
}

function lastProject() {
  const id = profile && localStorage.getItem(prefix + 'project:' + profile.id);
  return projects.find(item => item.id === id);
}

function renderHome() {
  const recent = lastProject();
  const state = hostState(profile);
  const canResume = !!recent && state === 'online';
  get('resume').hidden = !canResume;
  get('browse-projects').hidden = !canResume;
  get('home-empty').hidden = canResume;
  get('home-guide').hidden = profiles.length > 0;
  get('home-context').hidden = !profile;
  get('home-context').dataset.state = state === 'expired' ? 'offline' : state;
  get('home-context-name').textContent = profile?.name ?? '';
  get('home-context-state').textContent = {
    online: projects.length + ' 个已信任项目 · 可以打开终端',
    checking: '正在读取项目…', offline: '电脑暂时不可达', expired: '配对已失效', saved: '等待连接',
  }[state];
  get('home-reconnect').hidden = state !== 'offline';
  if (canResume) {
    get('resume-name').textContent = recent.name;
    get('resume-host').textContent = profile.name + ' / ' + projectSourceLabel(recent);
  }
  const quickProjects = projects.filter(item => item.id !== (canResume ? recent.id : null)).slice(0, 3);
  get('home-projects').hidden = state !== 'online' || !quickProjects.length;
  get('home-project-list').replaceChildren(...quickProjects.map(projectRow));
  const homeStates = {
    checking: ['正在连接电脑', '正在读取已信任的项目。', '查看连接'],
    offline: ['电脑暂时不可达', '检查手机和电脑的网络后重试。', '重新连接'],
    expired: ['配对已失效', '请在电脑端重新启用 Android 移动连接。', '重新配对'],
    online: ['打开终端', '选择已信任的项目，接回已有会话或启动 Shell。', '选择项目'],
    saved: profiles.length
      ? ['选择一台电脑', '从已配对的电脑进入终端。', '查看连接']
      : ['连接一台 QingCode', '配对电脑后，就能在这里打开远程终端。', '添加连接'],
  };
  const [title, description, action] = homeStates[state];
  get('home-empty-title').textContent = title;
  get('home-empty-text').textContent = description;
  get('home-action').textContent = action;
}

function projectRow(item) {
  const path = item.kind === 'ssh' ? item.path.replace(/^ssh:\/\/[^/]+/, '') : item.path;
  const row = button('row', () => { void openProject(item); });
  const text = rowText(item.name, projectSourceLabel(item));
  text.lastElementChild.className = 'project-source';
  const location = document.createElement('small');
  location.className = 'project-path';
  location.textContent = path;
  text.append(location);
  row.dataset.kind = item.kind;
  row.append(tile(item.kind === 'ssh' ? 'host' : 'folder'), text, icon('chevron', 'arrow'));
  return row;
}

function renderProjects() {
  const query = get('search').value.trim().toLowerCase();
  const matching = projects.filter(item => matchesProject(item, kind, query));
  const list = get('project-list');
  list.replaceChildren(...matching.map(projectRow));
  const checking = hostState(profile) === 'checking';
  list.setAttribute('aria-busy', String(checking));
  get('refresh').disabled = !profile || checking;
  get('refresh').textContent = checking ? '读取中…' : '刷新';
  get('project-filters').hidden = !profile;
  get('project-subtitle').textContent = profile ? profile.name + ' · 已信任项目' : '请先在「连接」中配对电脑。';
  get('list-label').textContent = matching.length ? matching.length + ' 个项目'
    : loaded ? (query ? '没有匹配的项目' : kind === 'wsl'
      ? '本机 WSL 没有已信任的项目；通过远端连接访问的 WSL 项目请在「远端」中查看。'
      : '当前环境没有已信任的项目')
      : hostState(profile) === 'checking' ? '正在读取项目…' : '';
  const empty = !matching.length && !checking;
  get('project-empty').hidden = !empty;
  const filtered = !!query || kind !== 'all';
  get('project-empty-title').textContent = !profile ? '先连接一台电脑' : filtered ? '没有匹配的项目' : '暂无可用项目';
  get('project-empty-text').textContent = !profile ? '配对后即可查看电脑上的已信任项目。'
    : filtered ? '试试其他关键词，或清除筛选查看全部项目。'
    : loaded ? '在电脑端添加并信任项目，再回到这里刷新。' : '检查电脑连接后重新读取项目。';
  get('project-empty-action').textContent = !profile ? '前往连接' : filtered ? '清除筛选' : '重新读取';
}

function updateHost(state) {
  if (profile) health.set(profile.id, state);
  renderConnections();
  renderHome();
  renderProjects();
}

async function refreshProjects() {
  if (!profile) return false;
  const epoch = ++profileEpoch;
  message('project-error', '');
  message('connection-error', '');
  updateHost('checking');
  try {
    const list = await remote('projects');
    if (epoch !== profileEpoch) return false;
    projects = list;
    loaded = true;
    updateHost('online');
    return true;
  } catch (error) {
    if (epoch !== profileEpoch) return false;
    updateHost(error.revoked ? 'expired' : 'offline');
    message('project-error', error.message);
    message('connection-error', error.message);
    return false;
  }
}

async function activate(item, next = 'home') {
  if (profile?.id !== item.id) {
    leaveTerminal();
    if (profile) {
      localStorage.removeItem(prefix + 'open');
      if (hostState(profile) !== 'expired') health.delete(profile.id);
    }
    projects = [];
    loaded = false;
    setKind('all');
  }
  profile = item;
  localStorage.setItem(prefix + 'active', item.id);
  showPage(next);
  return refreshProjects();
}

function putProfile(item) {
  profiles = [...profiles.filter(saved => saved.id !== item.id), item];
  if (profile?.id === item.id) profile = item;
}

function openPair(item, target = null) {
  const dialog = get('pair-dialog');
  get('host-dialog').close();
  expectedFingerprint = target?.fingerprint ?? null;
  get('pair-title').textContent = item ? '重新配对' : '添加连接';
  get('pair-name').value = item?.name ?? target?.name ?? '';
  get('pair-host').value = item?.host ?? target?.host ?? '';
  get('pair-port').value = item?.port ?? target?.port ?? String(DEFAULT_PORT);
  get('pair-code').value = '';
  get('pair-host').readOnly = !!item;
  get('pair-port').readOnly = !!item;
  get('pair-link-state').hidden = !expectedFingerprint;
  get('pair-link-tools').hidden = !!item;
  message('pair-error', '');
  if (!dialog.open) dialog.showModal();
  if (target) get('pair-code').focus();
}

function openPairTarget(target) {
  const saved = profiles.find(item => item.id === target.host + ':' + target.port);
  openPair(saved && saved.fingerprint === target.fingerprint ? saved : null, target);
}

window.qingLink = text => {
  try {
    const target = parsePairingLink(text);
    if (!terminalScreen.hidden) returnToDashboard('connection');
    else showPage('connection');
    openPairTarget(target);
  } catch (error) {
    if (!terminalScreen.hidden) returnToDashboard('connection');
    else showPage('connection');
    message('connection-error', error.message);
  }
};

get('pair-paste').addEventListener('click', async () => {
  message('pair-error', '');
  try {
    openPairTarget(parsePairingLink(await rpc('clipboard')));
  } catch (error) {
    message('pair-error', error.message === '这不是 QingCode 配对链接。' ? '剪贴板中没有 QingCode 配对链接。' : error.message);
  }
});

function stopScan() {
  scanEpoch += 1;
  clearTimeout(scanTimer);
  scanTimer = null;
  for (const track of scanStream?.getTracks() ?? []) track.stop();
  scanStream = null;
  get('scan-video').srcObject = null;
}

get('scan-dialog').addEventListener('close', stopScan);

get('pair-scan').addEventListener('click', async () => {
  stopScan();
  const epoch = scanEpoch;
  const dialog = get('scan-dialog');
  const video = get('scan-video');
  message('pair-error', '');
  message('scan-error', '');
  dialog.showModal();
  try {
    if (!await rpc('camera')) throw new Error('需要相机权限才能扫码。也可以粘贴电脑端复制的配对链接。');
    if (epoch !== scanEpoch || !dialog.open) return;
    const stream = await requestScannerCamera(navigator.mediaDevices);
    if (epoch !== scanEpoch || !dialog.open) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    scanStream = stream;
    void focusScannerCamera(stream);
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    if (epoch !== scanEpoch) return;
    stopScan();
    message('scan-error', error.name === 'NotAllowedError' ? '需要相机权限才能扫码。也可以取消后粘贴配对链接。' : error.message || '无法打开相机。');
    return;
  }
  if (epoch !== scanEpoch || !dialog.open) return;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || typeof window.jsQR !== 'function') {
    stopScan();
    message('scan-error', '无法加载扫码组件，请取消后重试，或粘贴电脑端复制的配对链接。');
    return;
  }
  const tick = () => {
    if (!scanStream || epoch !== scanEpoch || !dialog.open) return;
    try {
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const text = decodeScannerFrame(video, canvas, context, window.jsQR);
        if (text) {
          const target = parsePairingLink(text);
          dialog.close();
          stopScan();
          openPairTarget(target);
          return;
        }
      }
    } catch (error) {
      message('scan-error', error.message || '暂时无法识别，请调整距离和光线后重试。');
    }
    scanTimer = setTimeout(tick, 180);
  };
  tick();
});

get('pair-dialog').addEventListener('cancel', event => {
  if (get('pair-submit').disabled) event.preventDefault();
});

get('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = get('pair-submit');
  if (submit.disabled) return;
  const cancel = get('pair-form').querySelector('[data-close]');
  const field = get('pair-code');
  const name = get('pair-name').value.trim();
  const host = get('pair-host').value.trim();
  const port = Number(get('pair-port').value);
  const code = field.value;
  submit.disabled = cancel.disabled = true;
  message('pair-error', '');
  try {
    if (!name) throw new Error('请输入连接名称。');
    if (!validIpv4(host) || !validPort(port)) throw new Error('请输入有效的电脑 IPv4 地址和端口。');
    if (!/^[!-~]{6,20}$/.test(code)) {
      throw new Error('密码须为 6–20 位，可使用数字、英文字母或符号，无需组合。');
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const fingerprint = await rpc('probe', { host, port });
    const saved = profiles.find(item => item.id === host + ':' + port);
    if (expectedFingerprint) {
      // The link came from the desktop screen, so a mismatch means a different or intercepted host.
      if (expectedFingerprint !== fingerprint) {
        throw new Error('电脑证书与二维码中的指纹不一致，已停止配对。请确认地址，或在电脑端重新生成二维码。');
      }
    } else if (saved && saved.fingerprint !== fingerprint) {
      throw new Error('电脑证书已变化，已停止配对。请重新扫描电脑端二维码或粘贴配对链接。');
    }
    const paired = await rpc('pair', { name, host, port, code, fingerprint });
    field.value = '';
    putProfile(paired);
    get('pair-dialog').close();
    await activate(paired);
  } catch (error) {
    message('pair-error', error.message);
  } finally {
    submit.disabled = cancel.disabled = false;
  }
});

function openHost(item) {
  editing = item;
  get('host-address').textContent = item.id;
  get('host-fingerprint').textContent = item.fingerprint;
  get('host-name').value = item.name;
  get('host-port').value = item.port;
  message('host-error', '');
  get('host-dialog').showModal();
}

get('host-form').addEventListener('submit', async event => {
  event.preventDefault();
  const item = editing;
  const submit = event.submitter ?? get('host-form').querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const name = get('host-name').value.trim();
    const port = Number(get('host-port').value);
    if (!validPort(port)) throw new Error('端口须为 1–65535 之间的整数。');
    let updated = item;
    if (port !== item.port) {
      // The desktop keeps pairings across port switches; only the address changes here.
      updated = await rpc('readdress', { profile: item.id, port });
      moveProfile(item, updated);
    }
    if (name !== updated.name) updated = await rpc('rename', { profile: updated.id, name });
    putProfile(updated);
    editing = updated;
    if (profile?.id === updated.id && port !== item.port) void refreshProjects();
    renderConnections();
    renderHome();
    renderProjects();
    get('host-dialog').close();
  } catch (error) {
    message('host-error', error.message);
  } finally {
    submit.disabled = false;
  }
});

get('repair-host').addEventListener('click', () => openPair(editing));
get('remove-host').addEventListener('click', async () => {
  const item = editing;
  if (!await confirmAction('移除 ' + item.name + '？', '此操作会删除手机上保存的配对。要撤销电脑端授权，请在电脑端停止移动连接。', '移除')) return;
  try {
    await rpc('forget', { profile: item.id });
    profiles = profiles.filter(saved => saved.id !== item.id);
    health.delete(item.id);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix + 'session:' + item.id + ':')) localStorage.removeItem(key);
    }
    for (const key of drafts.keys()) {
      if (key.startsWith(item.id + '/')) drafts.delete(key);
    }
    localStorage.removeItem(prefix + 'project:' + item.id);
    get('host-dialog').close();
    if (profile?.id === item.id) {
      profileEpoch += 1;
      profile = null;
      projects = [];
      loaded = false;
      localStorage.setItem(prefix + 'active', '');
      localStorage.removeItem(prefix + 'open');
      message('project-error', '');
      message('connection-error', '');
    }
    renderConnections();
    renderHome();
    renderProjects();
  } catch (error) {
    message('host-error', error.message);
  }
});

function moveProfile(from, to) {
  for (const [old, next] of renameProfileKeys(Object.keys(localStorage), prefix, from.id, to.id)) {
    localStorage.setItem(next, localStorage.getItem(old));
    localStorage.removeItem(old);
  }
  for (const [key, value] of [...drafts]) {
    if (key.startsWith(from.id + '/')) {
      drafts.delete(key);
      drafts.set(to.id + key.slice(from.id.length), value);
    }
  }
  if (health.has(from.id)) {
    health.set(to.id, health.get(from.id));
    health.delete(from.id);
  }
  profiles = profiles.filter(saved => saved.id !== from.id);
  if (profile?.id === from.id) {
    leaveTerminal();
    profile = to;
    localStorage.setItem(prefix + 'active', to.id);
    if (localStorage.getItem(prefix + 'open') === from.id) localStorage.setItem(prefix + 'open', to.id);
  }
}

function setKind(next) {
  kind = next;
  for (const item of get('hosts').querySelectorAll('button')) {
    item.setAttribute('aria-pressed', String(item.dataset.kind === next));
  }
  get('search').value = '';
}

get('active-host').addEventListener('click', () => showPage('connection'));
get('add-host').addEventListener('click', () => openPair());
get('refresh').addEventListener('click', () => { void refreshProjects(); });
get('search').addEventListener('input', renderProjects);
get('resume').addEventListener('click', () => { void openProject(lastProject()); });
get('browse-projects').addEventListener('click', () => showPage('project'));
get('home-all-projects').addEventListener('click', () => showPage('project'));
get('home-reconnect').addEventListener('click', () => { void refreshProjects(); });
get('project-empty-action').addEventListener('click', () => {
  if (!profile) showPage('connection');
  else if (get('search').value.trim() || kind !== 'all') {
    setKind('all');
    renderProjects();
  } else void refreshProjects();
});
get('home-action').addEventListener('click', () => {
  const state = hostState(profile);
  if (!profile) {
    if (profiles.length) showPage('connection');
    else openPair();
  } else if (state === 'expired') openPair(profile);
  else if (state === 'offline') void refreshProjects();
  else showPage(state === 'online' ? 'project' : 'connection');
});
for (const item of get('dashboard-nav').querySelectorAll('button')) {
  item.addEventListener('click', () => showPage(item.dataset.page));
}
for (const item of get('hosts').querySelectorAll('button')) {
  item.addEventListener('click', () => {
    setKind(item.dataset.kind);
    renderProjects();
  });
}

function setModifier(name, value) {
  modifiers[name] = value;
  get('special-keys').querySelector('[data-key="' + name + '"]').setAttribute('aria-pressed', String(value));
}

function clearModifiers() {
  setModifier('ctrl', false);
  setModifier('alt', false);
}

function setRawKeyboard(enabled) {
  if (term?.textarea) term.textarea.inputMode = enabled ? 'text' : 'none';
  get('keyboard').setAttribute('aria-pressed', String(enabled));
  get('keyboard').setAttribute('aria-label', enabled ? '切回命令栏输入' : '打开实时输入键盘');
  get('input-hint').textContent = enabled ? '实时输入 · 按键直接发送到终端' : '命令栏可编辑中文 · 空白发送为回车';
}

function focusRawKeyboard() {
  if (!term) return;
  // WebView reads inputmode when creating the input connection.
  if (term.textarea === document.activeElement && term.textarea.inputMode === 'none') term.textarea.blur();
  setRawKeyboard(true);
  term.focus();
}

function draftKey(id) {
  return profile.id + '/' + id;
}

function resizeComposer() {
  compose.style.height = '44px';
  compose.style.height = Math.min(compose.scrollHeight, 98) + 'px';
  get('send').setAttribute('aria-label', compose.value ? '发送并回车' : '发送回车');
  get('send').querySelector('use').setAttribute('href', compose.value ? '#i-send' : '#i-return');
}

function leaveTerminal() {
  terminalReady = false;
  if (inputTimer !== null) {
    clearTimeout(inputTimer);
    flushInput();
  }
  if (selected && compose.value) drafts.set(draftKey(selected), compose.value);
  else if (selected) drafts.delete(draftKey(selected));
  viewEpoch += 1;
  clearTimeout(resizing);
  selected = null;
  composing = false;
  clearModifiers();
  setRawKeyboard(false);
  get('scroll-bottom').hidden = true;
  disposeTouchScroll?.();
  disposeTouchScroll = undefined;
  term?.dispose();
  term = undefined;
  fit = undefined;
}

function makeTerminal() {
  term = new window.Terminal({
    allowProposedApi: false,
    fontSize: terminalFontSize,
    lineHeight: 1.2,
    fontFamily: 'monospace',
    scrollback: 2500,
    cursorBlink: true,
    // Keep ANSI colors and cursor aligned with the desktop dark terminal.
    theme: {
      background: '#101317',
      foreground: '#d4d4d4',
      cursor: '#aeafad',
      cursorAccent: '#101317',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#f48771',
      green: '#89d185',
      yellow: '#e2c08d',
      blue: '#75aaf0',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#d4d4d4',
      brightBlack: '#6b6b6b',
      brightRed: '#f48771',
      brightGreen: '#89d185',
      brightYellow: '#e2c08d',
      brightBlue: '#75aaf0',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff',
    },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(get('viewport'));
  disposeTouchScroll = attachTerminalTouchScroll(term.element);
  setRawKeyboard(false);
  term.textarea.addEventListener('blur', () => setRawKeyboard(false));
  fit.fit();
  updateTerminalSize();
  term.onData(data => sendInput(data));
  term.onResize(() => {
    updateTerminalSize();
    clearTimeout(resizing);
    resizing = setTimeout(sendSize, 120);
  });
  term.onScroll(() => {
    const buffer = term.buffer.active;
    get('scroll-bottom').hidden = buffer.viewportY >= buffer.baseY;
  });
}

function updateTerminalSize() {
  get('terminal-size').textContent = term ? term.cols + ' × ' + term.rows : '';
}

function renderFontSize() {
  get('font-size').textContent = terminalFontSize + 'px';
  get('font-smaller').disabled = terminalFontSize <= 11;
  get('font-larger').disabled = terminalFontSize >= 20;
}

for (const [id, delta] of [['font-smaller', -1], ['font-larger', 1]]) {
  get(id).addEventListener('click', () => {
    terminalFontSize = Math.max(11, Math.min(20, terminalFontSize + delta));
    localStorage.setItem(prefix + 'font-size', String(terminalFontSize));
    if (term) {
      term.options.fontSize = terminalFontSize;
      fit.fit();
    }
    renderFontSize();
  });
}
renderFontSize();
get('scroll-bottom').addEventListener('click', () => { term?.scrollToBottom(); });

new ResizeObserver(() => {
  if (term && !terminalScreen.hidden) fit.fit();
}).observe(get('viewport'));

function dimensions() {
  return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 };
}

function sendSize() {
  if (!selected || !terminalReady) return;
  void remote('resize', { id: selected, ...dimensions() }).catch(() => {
    // The next successful output poll reapplies the size on reconnect.
  });
}

function terminalState(text, state = 'idle', retry = false) {
  terminalReady = state === 'online';
  get('terminal-status').textContent = text;
  get('terminal-dot').dataset.state = state;
  get('terminal-retry').hidden = !retry;
  for (const control of document.querySelectorAll('#special-keys button, #keyboard, #send')) {
    control.disabled = !terminalReady;
  }
}

function handleTerminalError(error, retry = true) {
  if (error.revoked) {
    returnToDashboard('connection');
    updateHost('expired');
    message('connection-error', error.message);
  } else {
    terminalState(error.message, 'offline', retry);
  }
}

async function openProject(item, resumeOnly = false) {
  if (!item || busy) return;
  busy = true;
  leaveTerminal();
  const epoch = viewEpoch;
  project = item;
  sessions = [];
  compose.value = '';
  get('terminal-name').textContent = item.name;
  get('terminal-host').textContent = profile.name + ' / ' + projectSourceLabel(item);
  get('dashboard').hidden = true;
  terminalScreen.hidden = false;
  makeTerminal();
  renderSessions();
  terminalState('正在连接终端…');
  try {
    const list = await remote('sessions', { project: item.id });
    if (epoch !== viewEpoch) return;
    sessions = list;
    const previous = localStorage.getItem(sessionKey(item.id));
    const existing = sessions.find(session => session.id === previous)
      ?? sessions.find(session => !session.exit)
      ?? sessions[0];
    if (existing) selectSession(existing);
    else if (resumeOnly) returnToDashboard('home');
    else await createSession(epoch);
  } catch (error) {
    if (epoch === viewEpoch) handleTerminalError(error);
  } finally {
    busy = false;
  }
}

function renderSessions() {
  const tabs = get('session-tabs');
  const options = get('session-options');
  const scroll = tabs.scrollLeft;
  tabs.replaceChildren();
  options.replaceChildren();
  get('end-session').disabled = !selected;
  get('end-session').textContent = sessions.find(item => item.id === selected)?.exit ? '移除已结束会话' : '结束当前会话';
  for (const [index, session] of sessions.entries()) {
    const label = '终端 ' + (session.number ?? index + 1);
    const tab = button('session-tab', () => { if (!busy) selectSession(session); });
    tab.textContent = label + (session.exit ? ' · 已结束' : '');
    const option = button('row', () => { if (!busy) selectSession(session); });
    option.append(tile('terminal'), rowText(label, session.exit ? '已结束' : '可接入'), icon('chevron', 'arrow'));
    if (session.id === selected) {
      tab.setAttribute('aria-current', 'true');
      option.setAttribute('aria-current', 'true');
    }
    tabs.append(tab);
    options.append(option);
  }
  tabs.scrollLeft = scroll;
  tabs.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function createSession(epoch) {
  const session = await remote('create', { project: project.id, ...dimensions() });
  if (epoch !== viewEpoch) return;
  sessions.push(session);
  selectSession(session);
}

function selectSession(session) {
  get('session-dialog').close();
  if (selected === session.id) return;
  leaveTerminal();
  selected = session.id;
  compose.value = drafts.get(draftKey(selected)) ?? '';
  resizeComposer();
  localStorage.setItem(sessionKey(project.id), session.id);
  localStorage.setItem(prefix + 'project:' + profile.id, project.id);
  localStorage.setItem(prefix + 'open', profile.id);
  renderHome();
  makeTerminal();
  renderSessions();
  terminalState('正在接入终端…');
  void poll(session, viewEpoch);
}

async function poll(session, epoch) {
  let next = 0;
  let backoff = 350;
  while (epoch === viewEpoch) {
    if (document.hidden) {
      await new Promise(resolve => setTimeout(resolve, 350));
      continue;
    }
    try {
      const data = await remote('poll', { id: session.id, from: next });
      if (epoch !== viewEpoch) return;
      next = data.next;
      if (data.reset) {
        term.reset();
        term.writeln('[较早的输出已超出电脑端缓存]');
      }
      for (const raw of data.chunks) {
        if (epoch !== viewEpoch) return;
        const view = term;
        // Screen snapshots are terminal text; only byte chunks are base64.
        const chunk = outputChunk(raw);
        if (chunk.screen) {
          view.reset();
          view.resize(chunk.cols, chunk.rows);
        }
        await new Promise(resolve => {
          // Disposing the renderer can drop its pending write callback.
          const fallback = setTimeout(resolve, 250);
          view.write(chunk.data, () => { clearTimeout(fallback); resolve(); });
        });
        if (chunk.screen && epoch === viewEpoch) fit.fit();
      }
      if (epoch !== viewEpoch) return;
      if (data.exit) {
        if (!session.exit) {
          session.exit = data.exit;
          renderSessions();
        }
        terminalState(data.exit.disconnected ? '电脑到远端的终端连接已中断' : '会话已结束 · 退出码 ' + data.exit.exitCode);
        if (data.more) continue;
        return;
      }
      if (!terminalReady) {
        terminalState('会话中', 'online');
        if (hostState(profile) !== 'online') updateHost('online');
        sendSize();
      }
      backoff = 350;
    } catch (error) {
      if (epoch !== viewEpoch) return;
      if (error.revoked) {
        handleTerminalError(error);
        return;
      }
      if (error.message === '终端不存在。') {
        sessions = sessions.filter(item => item.id !== session.id);
        selected = null;
        renderSessions();
        terminalState('会话已在远端关闭，可新建终端', 'offline');
        return;
      }
      terminalState('连接中断，正在接回会话…', 'offline');
      if (hostState(profile) !== 'offline') updateHost('offline');
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 3000);
    }
  }
}

function flushInput() {
  inputTimer = null;
  const pending = inputQueue;
  inputQueue = '';
  const id = selected;
  const address = profile?.id;
  const epoch = viewEpoch;
  if (!id || !pending) return;
  queuedInput += pending.length;
  inputChain = inputChain.then(async () => {
    try {
      for (const part of splitInput(pending)) {
        await remote('input', { id, data: part }, address);
      }
    } catch (error) {
      if (epoch === viewEpoch) {
        if (error.revoked) handleTerminalError(error);
        else get('terminal-status').textContent = '输入提交结果未知，请检查终端输出。';
      }
    } finally {
      queuedInput -= pending.length;
    }
  });
}

function sendInput(value) {
  if (!terminalReady) return false;
  if (modifiers.ctrl || modifiers.alt) {
    value = applyModifiers(value, modifiers);
    clearModifiers();
  }
  if (queuedInput + inputQueue.length + value.length > 32_768) {
    get('terminal-status').textContent = '输入过长，请分段粘贴。';
    return false;
  }
  inputQueue += value;
  if (inputTimer === null) inputTimer = setTimeout(flushInput, 22);
  return true;
}

get('back').addEventListener('click', () => returnToDashboard());
get('manage-sessions').addEventListener('click', () => get('session-dialog').showModal());
get('terminal-retry').addEventListener('click', () => { void openProject(project); });
get('new-session').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  const epoch = viewEpoch;
  const wasReady = terminalReady;
  if (!selected) terminalState('正在新建终端…');
  try {
    // Pick up sessions whose creation response may have been lost.
    const list = await remote('sessions', { project: project.id });
    if (epoch !== viewEpoch) return;
    sessions = list;
    renderSessions();
    await createSession(epoch);
  } catch (error) {
    if (epoch === viewEpoch) {
      if (wasReady && !error.revoked) get('terminal-status').textContent = error.message;
      else handleTerminalError(error);
    }
  } finally {
    busy = false;
  }
});
get('end-session').addEventListener('click', async () => {
  if (busy || !selected) return;
  const id = selected;
  const epoch = viewEpoch;
  const ended = sessions.find(item => item.id === id)?.exit;
  if (!await confirmAction(ended ? '移除会话？' : '结束当前会话？',
    ended ? '此会话的输出将从列表中移除。' : '该会话中的 Shell 和前台任务将被关闭。', ended ? '移除' : '结束')) return;
  if (busy || epoch !== viewEpoch) return;
  busy = true;
  get('session-dialog').close();
  try {
    await remote('end', { id });
    if (epoch !== viewEpoch) return;
    sessions = sessions.filter(item => item.id !== id);
    compose.value = '';
    drafts.delete(draftKey(id));
    if (sessions.length) selectSession(sessions.find(item => !item.exit) ?? sessions[0]);
    else {
      localStorage.removeItem(sessionKey(project.id));
      returnToDashboard('home');
    }
  } catch (error) {
    if (epoch === viewEpoch) {
      if (error.revoked) handleTerminalError(error);
      else get('terminal-status').textContent = error.message;
    }
  } finally {
    busy = false;
  }
});

for (const keyButton of get('special-keys').querySelectorAll('[data-key]')) {
  keyButton.addEventListener('pointerdown', event => {
    if (document.activeElement === compose || document.activeElement === term?.textarea) event.preventDefault();
  });
  keyButton.addEventListener('click', () => {
    const key = keyButton.dataset.key;
    if (key === 'ctrl' || key === 'alt') {
      setModifier(key, !modifiers[key]);
      if (modifiers[key]) focusRawKeyboard();
    } else if (key === 'interrupt') {
      // Dedicated interruption always sends Ctrl+C, independent of pending modifiers.
      clearModifiers();
      sendInput('\x03');
    } else {
      // Navigation keys take pending modifiers too, e.g. Alt+← moves by word.
      sendInput(keySequence(key, { applicationCursor: term?.modes.applicationCursorKeysMode }));
    }
  });
}
get('keyboard').addEventListener('pointerdown', event => {
  if (document.activeElement === term?.textarea) event.preventDefault();
});
get('keyboard').addEventListener('click', () => {
  if (get('keyboard').getAttribute('aria-pressed') === 'true') {
    term?.textarea?.blur();
    setRawKeyboard(false);
    compose.focus();
  } else focusRawKeyboard();
});
for (const id of ['paste', 'send']) {
  get(id).addEventListener('pointerdown', event => {
    if (document.activeElement === compose && !composing) event.preventDefault();
  });
}
get('paste').addEventListener('click', async () => {
  const epoch = viewEpoch;
  try {
    const value = await rpc('clipboard');
    if (epoch !== viewEpoch || !value) return;
    compose.setRangeText(value, compose.selectionStart, compose.selectionEnd, 'end');
    resizeComposer();
  } catch (error) {
    if (epoch === viewEpoch) get('terminal-status').textContent = error.message;
  }
});
compose.addEventListener('input', resizeComposer);
compose.addEventListener('compositionstart', () => { composing = true; });
compose.addEventListener('compositionend', () => { composing = false; });
get('compose-form').addEventListener('submit', event => {
  event.preventDefault();
  if (composing) return;
  const value = compose.value.replace(/\r?\n/g, '\r');
  const payload = value.includes('\r') && term?.modes.bracketedPasteMode
    ? '\x1b[200~' + value + '\x1b[201~' : value;
  if (sendInput(payload + '\r')) {
    compose.value = '';
    resizeComposer();
  }
});

async function initialize() {
  try {
    profiles = await rpc('profiles');
    const savedAddress = localStorage.getItem(prefix + 'active');
    const item = profiles.find(entry => entry.id === savedAddress)
      ?? (savedAddress === null && profiles.length === 1 ? profiles[0] : null);
    if (item && savedAddress === null) {
      // Migrate the previous single-device session preferences.
      for (const key of Object.keys(localStorage)) {
        const oldPrefix = 'qingcode:mobile-session:';
        if (key.startsWith(oldPrefix)) {
          localStorage.setItem(prefix + 'session:' + item.id + ':' + key.slice(oldPrefix.length), localStorage.getItem(key));
          localStorage.removeItem(key);
        }
      }
    }
    renderConnections();
    renderHome();
    renderProjects();
    const link = await rpc('pendingLink');
    if (link) {
      if (item) await activate(item, 'connection');
      window.qingLink(link);
      return;
    }
    if (!item) return;
    const resume = localStorage.getItem(prefix + 'open') === item.id;
    if (await activate(item) && resume && profile?.id === item.id && page === 'home') {
      const recent = lastProject();
      if (recent) await openProject(recent, true);
    }
  } catch (error) {
    showPage('connection');
    message('connection-error', error.message);
  }
}

void initialize();
