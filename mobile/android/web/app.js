import {
  DEFAULT_PORT,
  launchCommand,
  applyModifiers,
  avatarFor,
  consumeModifier,
  keySequence,
  matchesProject,
  nextModifierState,
  outputChunk,
  parsePairingLink,
  projectSourceLabel,
  recentProjects,
  rememberProject,
  renameProfileKeys,
  splitInput,
  validIpv4,
  validPort,
} from './protocol.js';
import { decodeScannerFrame, focusScannerCamera, requestScannerCamera } from './scanner.js';
import { attachTerminalTouchScroll } from './terminalTouch.js';
import { attachKeyRepeat, attachPullToRefresh, attachSheetDrag } from './gestures.js';
import { composerInput, editDraft, isSlashDraft } from './composer.js';
import { attachTerminalHistory } from './terminalHistory.js';
import { attachTerminalSelection } from './terminalSelection.js';
import { createConnectionLatency, latencyText, TERMINAL_LATENCY_INTERVAL, HOME_LATENCY_INTERVAL } from './connectionLatency.js';
import { createWorkspaceState, terminalText, searchOffsets } from './workspaceState.js';

const get = id => document.getElementById(id);
const native = window.QingCodeNative;
const pages = { home: get('home-screen'), project: get('project-screen'), connection: get('connection-screen') };
const terminalScreen = get('terminal-screen');
const compose = get('compose');
const requests = new Map();
const health = new Map();
let persistenceFailed = false;
const workspace = createWorkspaceState({ storage: localStorage, onError: () => { persistenceFailed = true; } });
const drafts = workspace.drafts;
const inputModes = new Map();
let inputMode = 'compose';
const keyRepeats = [];
const prefix = 'qingcode:mobile:';
const landscape = window.matchMedia('(orientation: landscape) and (min-width: 600px)');
let deviceLandscape = landscape.matches;
let nativeOrientation = false;
let keysPreference = localStorage.getItem(prefix + 'keys-collapsed');
let fullscreen = false;
let fullscreenEpoch = 0;
let requestId = 0;
let profiles = [];
let profile = null;
let project = null;
let projects = [];
let loaded = false;
let profileEpoch = 0;
let page = 'home';
let sessions = [];
let selected = null;
let viewEpoch = 0;
let term;
let fit;
let disposeTouchScroll;
let terminalHistory;
let terminalSelection;
let terminalReady = false;
// 修饰键三态 off / once / lock，lastTap 用于识别双击锁定。
const modifiers = { ctrl: 'off', alt: 'off' };
const lastTap = { ctrl: -Infinity, alt: -Infinity };
let busy = false;
let inputQueue = '';
let inputCompletions = [];
let inputTimer = null;
let inputChain = Promise.resolve();
let queuedInput = 0;
let resizing = null;
let editing = null;
let composing = false;
let editorComposing = false;
let readerText = '';
let readerMatches = [];
let readerIndex = 0;
const savedColumns = localStorage.getItem('qingcode:mobile:columns');
let terminalColumns = ['80', '100'].includes(savedColumns) ? Number(savedColumns) : 0;
let fitting = null;
// Fingerprint from a scanned or pasted pairing link; skips manual comparison when it matches.
let expectedFingerprint = null;
let scanStream = null;
let scanTimer = null;
let scanEpoch = 0;
const savedFontSize = Number(localStorage.getItem(prefix + 'font-size'));
let terminalFontSize = Number.isInteger(savedFontSize) && savedFontSize >= 11 && savedFontSize <= 20 ? savedFontSize : 13;
const connectionLatency = createConnectionLatency({
  measure: address => rpc('latency', { profile: address }),
  onChange: renderLatency,
});
window.qingVisibility = visible => {
  if (!visible) saveDraft();
  connectionLatency.setForeground(visible === true);
};

function syncLatency() {
  connectionLatency.setTarget(profile && hostState(profile) === 'online' ? profile : null,
    terminalScreen.hidden ? HOME_LATENCY_INTERVAL : TERMINAL_LATENCY_INTERVAL);
  renderLatency();
}

function renderLatency() {
  const snapshot = connectionLatency.getSnapshot();
  const value = latencyText(snapshot);
  get('terminal-latency').textContent = '电脑 ' + value;
  get('terminal-latency').setAttribute('aria-label', '手机到电脑往返延迟 ' + value);
  get('home-latency').textContent = profile && hostState(profile) === 'online' ? ' · 电脑 ' + value : '';
  if (!editing || editing.id !== profile?.id) {
    get('host-latency').textContent = '延迟仅检测当前连接的电脑。';
    return;
  }
  const state = {
    idle: '尚未测量。', failed: '本次检测未获得结果。', stale: '结果已过期，等待更新。',
    unsupported: '当前电脑端不支持延迟检测，请更新电脑端 QingCode。', ready: '',
  }[snapshot.state];
  const time = snapshot.checkedAt === null ? '' : '最近测量 ' + new Date(snapshot.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) + '。';
  get('host-latency').textContent = '手机到电脑往返延迟：' + value + '。' + time + state + '不包含电脑到远端及终端程序处理耗时。';
}

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
  syncLatency();
}

function returnToDashboard(next = page) {
  localStorage.removeItem(prefix + 'open');
  leaveTerminal();
  showPage(next);
}

window.qingBack = () => {
  for (const id of ['scan-dialog', 'confirm-dialog', 'pair-confirm', 'host-dialog', 'pair-dialog', 'keys-dialog', 'session-dialog', 'new-session-dialog', 'image-dialog', 'terminal-menu-dialog', 'expanded-dialog', 'submissions-dialog', 'reader-dialog']) {
    const dialog = get(id);
    if (!dialog.open) continue;
    if (id !== 'pair-dialog' || !get('pair-submit').disabled) dialog.close('cancel');
    return true;
  }
  if (!terminalScreen.hidden) {
    if (terminalSelection?.close()) return true;
    if (terminalHistory?.close()) return true;
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

function avatar(name) {
  const { initials, hue } = avatarFor(name);
  const element = document.createElement('span');
  element.className = 'avatar';
  element.dataset.hue = String(hue);
  element.textContent = initials;
  element.setAttribute('aria-hidden', 'true');
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
    select.append(avatar(item.name), text, dot);
    card.append(select, detail);
    list.append(card);
  }
  get('active-host-name').textContent = profile?.name ?? '未连接';
  const state = hostState(profile);
  get('active-host').dataset.state = state === 'expired' ? 'offline' : state;
  get('active-host').setAttribute('aria-label', profile ? '切换连接，当前为 ' + profile.name : '管理连接');
  syncLatency();
}

function sessionKey(projectId) {
  return prefix + 'session:' + profile.id + ':' + projectId;
}

function lastProject() {
  const id = profile && localStorage.getItem(prefix + 'project:' + profile.id);
  return projects.find(item => item.id === id);
}

function projectHistory() {
  if (!profile) return [];
  try {
    const raw = localStorage.getItem(prefix + 'recent-projects:' + profile.id);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* Ignore damaged history; the desktop's saved times remain available. */ }
  const previous = lastProject();
  return previous ? [{ id: previous.id, openedAt: 1 }] : [];
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
  const recentList = recentProjects(projects, projectHistory());
  get('home-projects').hidden = state !== 'online' || !projects.length;
  get('home-project-list').replaceChildren(...recentList.map(projectRow));
  get('home-recent-empty').hidden = recentList.length > 0;
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
  const matching = projects.filter(item => matchesProject(item, query));
  const list = get('project-list');
  list.replaceChildren(...matching.map(projectRow));
  const checking = hostState(profile) === 'checking';
  list.setAttribute('aria-busy', String(checking));
  get('refresh').disabled = !profile || checking;
  get('refresh').dataset.busy = String(checking);
  get('refresh').setAttribute('aria-label', checking ? '正在读取项目' : '刷新项目');
  get('project-filters').hidden = !profile;
  get('project-subtitle').textContent = profile ? profile.name + ' · 已信任项目' : '请先在「连接」中配对电脑。';
  get('list-label').textContent = matching.length ? matching.length + ' 个项目'
    : loaded ? (query ? '没有匹配的项目' : '没有已信任的项目')
      : hostState(profile) === 'checking' ? '正在读取项目…' : '';
  const empty = !matching.length && !checking;
  get('project-empty').hidden = !empty;
  const filtered = !!query;
  get('project-empty-title').textContent = !profile ? '先连接一台电脑' : filtered ? '没有匹配的项目' : '暂无可用项目';
  get('project-empty-text').textContent = !profile ? '配对后即可查看电脑上的已信任项目。'
    : filtered ? '试试其他关键词，或清除搜索查看全部项目。'
    : loaded ? '在电脑端添加并信任项目，再回到这里刷新。' : '检查电脑连接后重新读取项目。';
  get('project-empty-action').textContent = !profile ? '前往连接' : filtered ? '清除搜索' : '重新读取';
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
    get('search').value = '';
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
    connectionLatency.invalidate(paired.id);
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
  renderLatency();
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
    if (profile?.id === item.id) leaveTerminal();
    profiles = profiles.filter(saved => saved.id !== item.id);
    health.delete(item.id);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix + 'session:' + item.id + ':')) localStorage.removeItem(key);
    }
    workspace.removeHost(item.id);
    localStorage.removeItem(prefix + 'project:' + item.id);
    localStorage.removeItem(prefix + 'recent-projects:' + item.id);
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
  workspace.renameHost(from.id, to.id);
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
  else if (get('search').value.trim()) {
    get('search').value = '';
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
function setModifier(name, state) {
  modifiers[name] = state;
  const key = get('keys-dialog').querySelector('[data-key="' + name + '"]');
  key.setAttribute('aria-pressed', String(state !== 'off'));
  key.dataset.locked = String(state === 'lock');
}

function clearModifiers() {
  setModifier('ctrl', 'off');
  setModifier('alt', 'off');
}

/** 一次输入之后：单次修饰键复位，锁定的保持。 */
function consumeModifiers() {
  setModifier('ctrl', consumeModifier(modifiers.ctrl));
  setModifier('alt', consumeModifier(modifiers.alt));
}

function setRawKeyboard(enabled) {
  const nextMode = enabled ? 'raw' : 'compose';
  if (inputMode !== nextMode) cancelKeyRepeats();
  inputMode = nextMode;
  if (selected) inputModes.set(draftKey(selected), nextMode);
  if (term?.textarea) term.textarea.inputMode = enabled ? 'text' : 'none';
  get('keyboard').setAttribute('aria-pressed', String(enabled));
  get('keyboard').setAttribute('aria-label', enabled ? '切回命令栏输入' : '打开实时输入键盘');
  get('input-hint').textContent = enabled ? '终端实时输入 · ⌫ 删除远端文字 · ↵ 确认' : '手机草稿 · ⌫ 编辑本地文字 · 斜杠命令先查看候选';
  get('input-mode').textContent = enabled ? '终端实时输入' : '手机草稿';
  get('keys-target').textContent = '编辑目标：' + (enabled ? '终端实时输入' : '手机草稿');
  compose.placeholder = enabled ? '实时输入中 · 按键直接发送' : '输入命令，空白发送回车';
  get('compose-form').dataset.mode = enabled ? 'raw' : 'compose';
  updateComposerActions();
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
  updateComposerActions();
  saveDraft();
  if (get('expanded-dialog').open && document.activeElement !== get('expanded-compose')) get('expanded-compose').value = compose.value;
}

function saveDraft() {
  if (!selected || !profile) return;
  const key = draftKey(selected);
  if (compose.value) drafts.set(key, compose.value);
  else drafts.delete(key);
  if (persistenceFailed) {
    get('expanded-save-status').textContent = '手机保存失败，请复制并保留原文。';
    get('expanded-save-status').dataset.error = 'true';
    renderSubmissionState();
  }
}

function renderSubmissionState() {
  const latest = selected ? workspace.recent(draftKey(selected))[0] : null;
  const target = get('submission-state');
  target.hidden = !latest && !persistenceFailed;
  get('submission-status').textContent = persistenceFailed ? '手机保存失败，请保留原文'
    : latest?.state === 'sending' ? '正在发送…' : latest?.state === 'received' ? '电脑已接收 · 可查看原文' : '提交结果未知 · 原文已保留';
}

function openEditor() {
  term?.textarea?.blur();
  setRawKeyboard(false);
  get('expanded-context').textContent = profile.name + ' / ' + project.name;
  get('expanded-compose').value = compose.value;
  get('expanded-send').disabled = !terminalReady;
  get('expanded-dialog').showModal();
  get('expanded-compose').focus();
}

function showSubmissions() {
  const list = get('submission-list');
  list.replaceChildren();
  get('submission-preview').value = '';
  get('submission-feedback').textContent = '';
  const add = (label, text) => {
    const item = button('', () => { get('submission-preview').value = text; });
    item.textContent = label + ' · ' + text.slice(0, 60).replace(/\s+/g, ' ');
    list.append(item);
    if (!get('submission-preview').value) get('submission-preview').value = text;
  };
  const key = selected && draftKey(selected);
  for (const receipt of workspace.recent(key)) {
    const state = { sending: '发送中', received: '电脑已接收', unknown: '提交结果未知' }[receipt.state];
    add(state + ' ' + new Date(receipt.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), receipt.text);
  }
  for (const room of workspace.recoverable(profile.id, project.id, key)) {
    if (room.draft) add('本项目其他会话草稿', room.draft);
    for (const receipt of [...room.receipts].reverse()) add('本项目其他会话提交 · ' + ({ sending: '发送中', received: '电脑已接收', unknown: '结果未知' }[receipt.state]), receipt.text);
  }
  get('submissions-dialog').showModal();
}

function refreshReader() {
  readerText = get('reader-source').value === 'history' ? get('history-content').textContent.slice(-600_000) : term ? terminalText(term) : '';
  get('reader-refresh').textContent = '刷新内容';
  renderReader();
  get('reader-scroll').scrollTop = 0;
}

function renderReader() {
  readerMatches = searchOffsets(readerText, get('reader-query').value);
  readerIndex = 0;
  const content = get('reader-content');
  const fragment = document.createDocumentFragment();
  let offset = 0;
  let matchIndex = 0;
  for (const line of readerText.split('\n')) {
    const span = document.createElement('span');
    if (line.startsWith('+')) span.className = 'diff-added';
    if (line.startsWith('-')) span.className = 'diff-removed';
    let position = 0;
    while (matchIndex < readerMatches.length && readerMatches[matchIndex].start < offset + line.length) {
      const match = readerMatches[matchIndex];
      appendReaderText(span, line.slice(position, Math.max(0, match.start - offset)));
      const mark = document.createElement('mark');
      mark.dataset.match = String(matchIndex);
      mark.textContent = line.slice(Math.max(0, match.start - offset), match.end - offset);
      span.append(mark);
      position = Math.min(line.length, match.end - offset);
      if (match.end > offset + line.length) break;
      matchIndex += 1;
    }
    appendReaderText(span, line.slice(position) + '\n');
    fragment.append(span);
    offset += line.length + 1;
  }
  content.replaceChildren(fragment);
  updateReaderMatch(false);
}

function appendReaderText(parent, text) {
  let position = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = match[0].replace(/[.,;，。；）)]+$/u, '');
    parent.append(document.createTextNode(text.slice(position, match.index)));
    const link = button('reader-link', async () => {
      try { await rpc('open_link', { url }); }
      catch (error) { get('reader-status').textContent = error.message; }
    });
    link.textContent = url;
    link.setAttribute('role', 'link');
    parent.append(link);
    position = match.index + url.length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}

function updateReaderMatch(scroll = true) {
  for (const mark of get('reader-content').querySelectorAll('mark')) mark.dataset.active = String(Number(mark.dataset.match) === readerIndex);
  get('reader-status').textContent = get('reader-query').value
    ? readerMatches.length ? (readerIndex + 1) + ' / ' + readerMatches.length + (readerMatches.length === 500 ? '（最多 500 处）' : '') : '未找到'
    : readerText ? '只读快照' : '此范围暂无输出';
  if (scroll) get('reader-content').querySelector('mark[data-active="true"]')?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

get('terminal-menu').addEventListener('click', () => {
  get('terminal-menu-context').textContent = profile.name + ' / ' + project.name;
  get('terminal-menu-dialog').showModal();
});
for (const [id, action] of Object.entries({
  'menu-edit': openEditor,
  'menu-submissions': showSubmissions,
  'menu-read': () => {
    get('reader-source').value = terminalHistory?.isOpen() ? 'history' : 'terminal';
    refreshReader();
    get('reader-dialog').showModal();
  },
  'menu-sessions': () => get('session-dialog').showModal(),
  'menu-new': () => { if (!busy) get('new-session-dialog').showModal(); },
  'menu-dashboard': () => returnToDashboard('project'),
})) get(id).addEventListener('click', () => { get('terminal-menu-dialog').close(); action(); });
get('review-submission').addEventListener('click', showSubmissions);
get('expanded-compose').addEventListener('input', () => { compose.value = get('expanded-compose').value; resizeComposer(); });
get('expanded-compose').addEventListener('compositionstart', () => { editorComposing = true; cancelKeyRepeats(); updateComposerActions(); });
get('expanded-compose').addEventListener('compositionend', () => { editorComposing = false; updateComposerActions(); });
get('expanded-dialog').addEventListener('close', () => { editorComposing = false; updateComposerActions(); });
get('expanded-send').addEventListener('click', () => {
  if (editorComposing || !terminalReady) return;
  compose.value = get('expanded-compose').value;
  get('expanded-dialog').close();
  dispatchComposer('submit');
});
get('restore-submission').addEventListener('click', () => {
  const text = get('submission-preview').value;
  if (!text) return;
  compose.value += (compose.value ? '\n\n' : '') + text;
  resizeComposer();
  get('submissions-dialog').close();
  openEditor();
});
get('copy-submission').addEventListener('click', async () => {
  if (!get('submission-preview').value) return;
  try { await rpc('copy', { text: get('submission-preview').value }); get('submission-feedback').textContent = '原文已复制'; }
  catch (error) { get('submission-feedback').textContent = error.message; }
});
get('reader-refresh').addEventListener('click', refreshReader);
get('reader-source').addEventListener('change', refreshReader);
get('reader-query').addEventListener('input', () => { renderReader(); updateReaderMatch(); });
for (const [id, delta] of [['reader-previous', -1], ['reader-next', 1]]) get(id).addEventListener('click', () => {
  if (!readerMatches.length) return;
  readerIndex = (readerIndex + delta + readerMatches.length) % readerMatches.length;
  updateReaderMatch();
});
get('reader-wrap').addEventListener('change', () => { get('reader-content').dataset.wrap = String(get('reader-wrap').checked); });
get('reader-copy').addEventListener('click', async () => {
  try { await rpc('copy', { text: readerText }); get('reader-status').textContent = '输出已复制'; }
  catch (error) { get('reader-status').textContent = error.message; }
});
get('terminal-columns').value = String(terminalColumns);
get('terminal-columns').addEventListener('change', () => {
  terminalColumns = Number(get('terminal-columns').value);
  localStorage.setItem('qingcode:mobile:columns', String(terminalColumns));
  fitTerminal();
});

function updateComposerActions() {
  const raw = inputMode === 'raw';
  const slash = !raw && isSlashDraft(compose.value);
  get('send').setAttribute('aria-label', raw ? '确认终端中的选择或命令' : slash ? '查看命令或技能候选，不发送回车' : compose.value ? '发送并回车' : '发送回车');
  get('send').querySelector('use').setAttribute('href', slash ? '#i-keyboard' : !raw && compose.value ? '#i-send' : '#i-return');
  get('send-label').textContent = raw ? '确认' : slash ? '候选' : '发送';
  get('completion-help').textContent = slash ? '先查看候选，再确认' : '↑↓ 选择 · ↵ 确认';
  for (const button of document.querySelectorAll('#special-keys button, #keys-dialog [data-key], #keyboard, #send')) {
    button.disabled = !terminalReady || composing || editorComposing || (button.id === 'attach-image' && sendingImage)
      || (button.dataset.key === 'clear' && (raw || !compose.value))
      || (!raw && /[\r\n]/.test(compose.value) && ['slash', 'tab', 'reference'].includes(button.dataset.key));
  }
}

function dispatchComposer(action) {
  if (composing || editorComposing || !terminalReady) return false;
  const raw = inputMode === 'raw';
  let value = raw ? '' : compose.value;
  if (action === 'reference') {
    value = raw ? '@' : editDraft(value, compose.selectionStart, compose.selectionEnd, 'text', '@').value;
    action = 'preview';
  }
  const plan = composerInput(value, action, term?.modes.bracketedPasteMode);
  const key = selected && draftKey(selected);
  const text = raw ? '' : compose.value;
  let receipt;
  const onComplete = text ? state => {
    workspace.settle(key, receipt, state);
    if (selected && draftKey(selected) === key) renderSubmissionState();
  } : undefined;
  if (!plan || !sendInput(plan.data, { raw: plan.interactive, onComplete })) return false;
  if (text) receipt = workspace.submit(key, text);
  if (!raw) {
    compose.value = '';
    if (selected) drafts.delete(draftKey(selected));
  }
  if (plan.interactive) {
    clearModifiers();
    focusRawKeyboard();
    term?.scrollToBottom();
  }
  resizeComposer();
  renderSubmissionState();
  return true;
}

function renderShortcutVisibility() {
  const collapsed = keysPreference === null ? deviceLandscape : keysPreference === 'true';
  cancelKeyRepeats();
  get('special-keys').hidden = collapsed;
  get('toggle-keys').setAttribute('aria-expanded', String(!collapsed));
  get('toggle-keys').querySelector('span').textContent = collapsed ? '展开按键' : '收起按键';
  terminalScreen.dataset.keysCollapsed = String(collapsed);
  if (collapsed) clearModifiers();
}

function renderFullscreen(enabled) {
  fullscreen = enabled;
  terminalScreen.dataset.fullscreen = String(enabled);
}

async function setTerminalFullscreen(enabled) {
  if (fullscreen === enabled) return;
  const epoch = ++fullscreenEpoch;
  renderFullscreen(enabled);
  try {
    const actual = await rpc('fullscreen', { enabled });
    if (epoch === fullscreenEpoch) renderFullscreen(actual === true);
  } catch (error) {
    if (epoch !== fullscreenEpoch) return;
    renderFullscreen(false);
    get('terminal-status').textContent = error.message;
  }
}

function syncTerminalFullscreen() {
  return setTerminalFullscreen(!terminalScreen.hidden && deviceLandscape);
}

window.qingOrientation = isLandscape => {
  // Native configuration describes device rotation; IME resizing is not a rotation.
  nativeOrientation = true;
  deviceLandscape = isLandscape === true;
  renderShortcutVisibility();
  void syncTerminalFullscreen();
};
landscape.addEventListener('change', () => {
  if (!nativeOrientation) deviceLandscape = landscape.matches;
  renderShortcutVisibility();
  void syncTerminalFullscreen();
});
get('toggle-keys').addEventListener('click', () => {
  keysPreference = String(get('toggle-keys').getAttribute('aria-expanded') === 'true');
  localStorage.setItem(prefix + 'keys-collapsed', keysPreference);
  renderShortcutVisibility();
});
renderShortcutVisibility();

function leaveTerminal({ preserveFullscreen = false } = {}) {
  cancelKeyRepeats();
  if (get('keys-dialog').open) get('keys-dialog').close();
  if (!preserveFullscreen) void setTerminalFullscreen(false);
  terminalSelection?.dispose();
  terminalSelection = undefined;
  terminalHistory?.dispose();
  terminalHistory = undefined;
  terminalReady = false;
  if (inputTimer !== null) {
    clearTimeout(inputTimer);
    flushInput();
  }
  if (selected && compose.value) drafts.set(draftKey(selected), compose.value);
  else if (selected) drafts.delete(draftKey(selected));
  viewEpoch += 1;
  clearTimeout(resizing);
  clearTimeout(fitting);
  fitting = null;
  for (const id of ['terminal-menu-dialog', 'expanded-dialog', 'submissions-dialog', 'reader-dialog']) get(id).close();
  selected = null;
  composing = false;
  clearModifiers();
  setRawKeyboard(false);
  get('submission-state').hidden = true;
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
  const historyEpoch = viewEpoch;
  const historySession = selected;
  terminalHistory = attachTerminalHistory({
    term, get,
    onClose: () => disposeTouchScroll?.cancel?.(),
    loadPage: async before => {
      const data = await remote('history', { id: historySession, before });
      if (historyEpoch !== viewEpoch) throw new Error('会话已切换');
      return data;
    },
  });
  terminalSelection = attachTerminalSelection({
    term, container: get('viewport').parentElement,
    copyText: text => rpc('copy', { text }),
    onStart: () => disposeTouchScroll?.cancel?.(),
  });
  disposeTouchScroll = attachTerminalTouchScroll(term.element, {
    onLongPress: point => terminalSelection?.start(point),
    canInertia: () => terminalHistory?.isOpen() || (term?.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none'),
  });
  setRawKeyboard(!!selected && inputModes.get(draftKey(selected)) === 'raw');
  term.textarea.addEventListener('compositionstart', () => { composing = true; cancelKeyRepeats(); updateComposerActions(); });
  term.textarea.addEventListener('compositionend', () => { composing = false; updateComposerActions(); });
  fitTerminal();
  updateTerminalSize();
  term.onData(data => { sendInput(data); });
  term.onResize(() => {
    updateTerminalSize();
    clearTimeout(resizing);
    resizing = setTimeout(sendSize, 120);
  });
  term.onScroll(() => {
    if (terminalHistory?.isOpen()) return;
    const buffer = term.buffer.active;
    get('scroll-bottom').hidden = buffer.viewportY >= buffer.baseY;
  });
}

function updateTerminalSize() {
  get('terminal-size').textContent = term ? term.cols + ' × ' + term.rows : '';
}

function fitTerminal() {
  if (!term || !fit || terminalScreen.hidden) return;
  const screen = term.element.querySelector('.xterm-screen');
  const cellWidth = screen?.getBoundingClientRect().width / term.cols;
  get('viewport').dataset.columns = terminalColumns ? 'fixed' : 'fit';
  term.element.style.width = terminalColumns && cellWidth ? Math.ceil(terminalColumns * cellWidth) + 'px' : '100%';
  const size = fit.proposeDimensions();
  if (!size) return;
  const cols = terminalColumns || size.cols;
  if (cols !== term.cols || size.rows !== term.rows) term.resize(cols, size.rows);
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
      fitTerminal();
    }
    renderFontSize();
  });
}
renderFontSize();
get('scroll-bottom').addEventListener('click', () => { terminalHistory?.close(); term?.scrollToBottom(); });

new ResizeObserver(() => {
  clearTimeout(fitting);
  fitting = setTimeout(() => { fitting = null; fitTerminal(); }, 80);
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
  get('expanded-send').disabled = !terminalReady;
  get('terminal-status').textContent = text;
  get('terminal-dot').dataset.state = state;
  get('terminal-retry').hidden = !retry;
  for (const control of document.querySelectorAll('#special-keys button, #keys-dialog [data-key], #keyboard, #send')) {
    control.disabled = !terminalReady || (control.id === 'attach-image' && sendingImage);
  }
  updateComposerActions();
  syncLatency();
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
  void syncTerminalFullscreen();
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
  get('session-rail').hidden = sessions.length < 2;
  const options = get('session-options');
  const scroll = tabs.scrollLeft;
  tabs.replaceChildren();
  options.replaceChildren();
  get('end-session').disabled = !selected;
  get('end-all-sessions').disabled = !sessions.length;
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

async function createSession(epoch, launch = 'shell') {
  const session = await remote('create', { project: project.id, ...dimensions() });
  if (epoch !== viewEpoch) return;
  sessions.push(session);
  selectSession(session);
  if (launch !== 'shell') {
    // Send exactly once to the newly created session. Never use a current tab's id
    // after an await, and never retry a launch whose delivery is uncertain.
    try {
      await remote('input', { id: session.id, data: launchCommand(launch) });
    } catch (error) {
      if (selected === session.id) get('terminal-status').textContent = '启动结果未知，请检查终端输出。' + error.message;
    }
  }
}

function selectSession(session) {
  get('session-dialog').close();
  if (selected === session.id) return;
  leaveTerminal({ preserveFullscreen: true });
  selected = session.id;
  workspace.context(draftKey(selected), project.id, project.name);
  compose.value = drafts.get(draftKey(selected)) ?? '';
  resizeComposer();
  localStorage.setItem(sessionKey(project.id), session.id);
  localStorage.setItem(prefix + 'project:' + profile.id, project.id);
  try {
    localStorage.setItem(prefix + 'recent-projects:' + profile.id,
      JSON.stringify(rememberProject(projectHistory(), project.id)));
  } catch { /* Terminal access remains available when history cannot be saved. */ }
  localStorage.setItem(prefix + 'open', profile.id);
  renderHome();
  makeTerminal();
  renderSessions();
  terminalState('正在接入终端…');
  renderSubmissionState();
  void poll(session, viewEpoch);
}

async function poll(session, epoch) {
  let next = 0;
  let latest = true;
  let backoff = 350;
  while (epoch === viewEpoch) {
    if (document.hidden) {
      await new Promise(resolve => setTimeout(resolve, 350));
      continue;
    }
    try {
      const data = await remote('poll', { id: session.id, from: next, latest, tail: true });
      if (epoch !== viewEpoch) return;
      if (data.chunks.length && get('reader-dialog').open) get('reader-refresh').textContent = '刷新内容（有新输出）';
      latest = false;
      terminalHistory?.update(data.historyBefore, data.historyAvailable);
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
        if (chunk.screen && epoch === viewEpoch) fitTerminal();
      }
      if (data.chunks.length && (terminalHistory?.isOpen() || term.buffer.active.viewportY < term.buffer.active.baseY)) {
        get('scroll-bottom').querySelector('span').textContent = '有新输出 · 回到最新';
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
        saveDraft();
        sessions = sessions.filter(item => item.id !== session.id);
        renderSessions();
        terminalState('原会话已不存在 · 草稿保留，可新建终端恢复', 'offline');
        return;
      }
      terminalState('连接中断，正在接回会话…', 'offline');
      latest = true;
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
  const completions = inputCompletions;
  inputCompletions = [];
  const id = selected;
  const address = profile?.id;
  const epoch = viewEpoch;
  if (!id || !pending) { for (const complete of completions) complete('unknown'); return; }
  queuedInput += pending.length;
  inputChain = inputChain.then(async () => {
    try {
      for (const part of splitInput(pending)) {
        await remote('input', { id, data: part }, address);
      }
      for (const complete of completions) complete('received');
    } catch (error) {
      for (const complete of completions) complete('unknown');
      if (epoch === viewEpoch) {
        if (error.revoked) handleTerminalError(error);
        else get('terminal-status').textContent = '输入提交结果未知，请检查终端输出。';
      }
    } finally {
      queuedInput -= pending.length;
    }
  });
}

function sendInput(value, { raw = false, onComplete } = {}) {
  if (!terminalReady) return false;
  if (!raw && (modifiers.ctrl !== 'off' || modifiers.alt !== 'off')) {
    value = applyModifiers(value, { ctrl: modifiers.ctrl !== 'off', alt: modifiers.alt !== 'off' });
    consumeModifiers();
  }
  if (queuedInput + inputQueue.length + value.length > 32_768) {
    get('terminal-status').textContent = '输入过长，请分段粘贴。';
    return false;
  }
  inputQueue += value;
  if (onComplete) inputCompletions.push(onComplete);
  if (inputTimer === null) inputTimer = setTimeout(flushInput, 22);
  return true;
}

get('back').addEventListener('click', () => returnToDashboard());
get('manage-sessions').addEventListener('click', () => get('session-dialog').showModal());
get('terminal-retry').addEventListener('click', () => { void openProject(project); });
get('new-session').addEventListener('click', () => { if (!busy) get('new-session-dialog').showModal(); });
async function newSession(launch) {
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
    get('new-session-dialog').close();
    await createSession(epoch, launch);
  } catch (error) {
    if (epoch === viewEpoch) {
      if (wasReady && !error.revoked) get('terminal-status').textContent = error.message;
      else handleTerminalError(error);
    }
  } finally {
    busy = false;
  }
}
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

get('end-all-sessions').addEventListener('click', async () => {
  if (busy || !project || !sessions.length) return;
  let epoch = viewEpoch;
  const address = profile.id;
  const projectId = project.id;
  const previous = selected;
  busy = true;
  message('session-error', '');
  try {
    // Refresh before confirmation, then end only the exact sessions shown there.
    const targets = await remote('sessions', { project: projectId }, address);
    if (epoch !== viewEpoch) return;
    sessions = targets;
    renderSessions();
    if (!targets.length) {
      get('session-dialog').close();
      localStorage.removeItem(sessionKey(projectId));
      returnToDashboard('home');
      return;
    }
    if (!await confirmAction('结束全部会话？',
      `将结束「${profile.name} / ${project.name}」的全部 ${targets.length} 个手机会话，关闭其中的 Shell 和前台任务，并移除会话输出。其他项目和桌面终端不受影响。`, '结束全部')) return;
    if (epoch !== viewEpoch) return;
    get('session-dialog').close();
    // Pause polling and input while the confirmed terminals are being closed.
    leaveTerminal({ preserveFullscreen: true });
    epoch = viewEpoch;
    terminalState('正在结束全部会话…');
    const ended = new Set();
    const failed = [];
    for (const item of targets) {
      try {
        await remote('end', { id: item.id }, address);
        ended.add(item.id);
      } catch (error) {
        failed.push({ id: item.id, error });
      }
    }
    if (epoch !== viewEpoch) return;
    for (const id of ended) drafts.delete(draftKey(id));
    sessions = targets.filter(item => !ended.has(item.id));
    compose.value = '';
    if (!sessions.length) {
      localStorage.removeItem(sessionKey(projectId));
      returnToDashboard('home');
    } else {
      selectSession(sessions.find(item => item.id === previous) ?? sessions.find(item => !item.exit) ?? sessions[0]);
      message('session-error', `已结束 ${ended.size} 个会话，${failed.length} 个未确认结束，请核对后重试。`);
      get('session-dialog').showModal();
    }
  } catch (error) {
    if (epoch === viewEpoch) {
      if (error.revoked) handleTerminalError(error);
      else message('session-error', error.message);
    }
  } finally {
    busy = false;
    get('end-all-sessions').disabled = !sessions.length;
  }
});

function cancelKeyRepeats() {
  for (const repeat of keyRepeats) repeat.cancel();
}

function editCompose(action, text) {
  const result = editDraft(compose.value, compose.selectionStart, compose.selectionEnd, action, text);
  compose.value = result.value;
  compose.setSelectionRange(result.start, result.end);
  resizeComposer();
}

for (const keyButton of document.querySelectorAll('#special-keys [data-key], #keys-dialog [data-key]')) {
  keyButton.addEventListener('pointerdown', event => {
    if (document.activeElement === compose || document.activeElement === term?.textarea) event.preventDefault();
  });
  keyButton.addEventListener('click', () => {
    pressKey(keyButton);
    if (get('keys-dialog').contains(keyButton) && !['ctrl', 'alt'].includes(keyButton.dataset.key) && !keyButton.hasAttribute('data-repeat')) get('keys-dialog').close();
  });
  if (keyButton.hasAttribute('data-repeat')) keyRepeats.push(attachKeyRepeat(keyButton, () => pressKey(keyButton)));
}

function pressKey(keyButton) {
  if (keyButton.disabled || composing || editorComposing || !terminalReady) return;
  const key = keyButton.dataset.key;
  const modified = modifiers.ctrl !== 'off' || modifiers.alt !== 'off';
  if (key === 'ctrl' || key === 'alt') {
    const previous = modifiers[key];
    const next = nextModifierState(previous, performance.now(), lastTap[key]);
    lastTap[key] = next.at;
    setModifier(key, next.state);
    if (previous === 'off') {
      setRawKeyboard(true);
      if (!get('keys-dialog').open) focusRawKeyboard();
    }
  } else if (key === 'interrupt') {
    consumeModifiers();
    sendInput('\x03', { raw: true });
  } else if (key === 'slash') {
    dispatchComposer('slash');
  } else if (key === 'reference') {
    dispatchComposer('reference');
  } else if (key === 'tab' && !modified) {
    dispatchComposer('complete');
  } else if (inputMode === 'compose' && !modified && ['text', 'backspace', 'left', 'right', 'home', 'end', 'newline', 'delete-word', 'delete-line-start', 'clear'].includes(key)) {
    editCompose(key, keyButton.dataset.text);
  } else if (key === 'text') {
    sendInput(keyButton.dataset.text);
  } else if (key !== 'clear') {
    // Semantic editing keys are literal terminal actions; Ctrl+D is never a backspace.
    const literal = ['backspace', 'delete-word', 'delete-line-start', 'newline'].includes(key);
    if (literal) clearModifiers();
    sendInput(keySequence(key, { applicationCursor: term?.modes.applicationCursorKeysMode }), { raw: literal });
  }
}
get('more-keys').addEventListener('click', () => {
  cancelKeyRepeats();
  updateComposerActions();
  get('keys-dialog').showModal();
});
get('keys-dialog').addEventListener('close', () => {
  cancelKeyRepeats();
  if (terminalScreen.hidden || !selected) return;
  if (inputMode === 'raw') term?.focus();
  else compose.focus();
});
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
for (const id of ['send', 'toggle-keys']) {
  get(id).addEventListener('pointerdown', event => {
    if ((document.activeElement === compose || document.activeElement === term?.textarea) && !composing) event.preventDefault();
  });
}
compose.addEventListener('focus', () => setRawKeyboard(false));
compose.addEventListener('input', resizeComposer);
compose.addEventListener('compositionstart', () => { composing = true; cancelKeyRepeats(); updateComposerActions(); });
compose.addEventListener('compositionend', () => { composing = false; updateComposerActions(); });
get('compose-form').addEventListener('submit', event => {
  event.preventDefault();
  dispatchComposer('submit');
});

// 首页与项目页下拉刷新：重新读取项目，离线时等同重连。
for (const [screen, indicator] of [['home-screen', 'home-pull'], ['project-screen', 'project-pull']]) {
  attachPullToRefresh(get(screen), get(indicator), {
    enabled: () => !!profile && hostState(profile) !== 'checking' && hostState(profile) !== 'expired',
    onRefresh: () => refreshProjects(),
  });
}
for (const sheet of document.querySelectorAll('dialog.sheet')) {
  attachSheetDrag(sheet, sheet.querySelector('.sheet-handle'), () => sheet.close('cancel'));
}

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

for (const button of document.querySelectorAll('[data-launch]')) {
  button.addEventListener('click', () => { void newSession(button.dataset.launch); });
}
const compression = get('image-compression');
const savedCompression = localStorage.getItem(prefix + 'image-compression');
if (['original', 'low', 'medium', 'high'].includes(savedCompression)) compression.value = savedCompression;
compression.addEventListener('change', () => localStorage.setItem(prefix + 'image-compression', compression.value));
let sendingImage = false;
let imageEpoch = 0;
get('image-dialog').addEventListener('close', () => { imageEpoch += 1; });
async function sendImage() {
  if (sendingImage || !terminalReady || !selected) return;
  const id = selected;
  const epoch = viewEpoch;
  const address = profile.id;
  const attempt = ++imageEpoch;
  sendingImage = true;
  get('attach-image').disabled = true;
  get('attach-image').setAttribute('aria-busy', 'true');
  get('choose-image').disabled = true;
  message('image-error', '');
  try {
    const image = await rpc('pick_image', { compression: compression.value });
    if (!image || epoch !== viewEpoch || selected !== id || attempt !== imageEpoch) return;
    get('choose-image').textContent = '正在上传…';
    get('terminal-status').textContent = '正在上传图片…';
    const result = await remote('image', { id, data: image.data }, address);
    if (epoch !== viewEpoch || selected !== id || attempt !== imageEpoch) return;
    compose.value += (compose.value && !/\s$/.test(compose.value) ? ' ' : '') + result.path + ' ';
    drafts.set(draftKey(id), compose.value);
    resizeComposer();
    if (get('expanded-dialog').open) get('expanded-compose').value = compose.value;
    if (get('image-dialog').open) get('image-dialog').close();
    get('terminal-status').textContent = '图片已就绪，可补充说明后发送';
    compose.focus();
  } catch (error) {
    if (epoch === viewEpoch && selected === id && attempt === imageEpoch) {
      if (error.revoked) handleTerminalError(error);
      else {
        get('terminal-status').textContent = '图片上传失败，可重新选择';
        message('image-error', error.message);
        if (!get('image-dialog').open) get('image-dialog').showModal();
      }
    }
  } finally {
    sendingImage = false;
    get('attach-image').disabled = !terminalReady;
    get('attach-image').removeAttribute('aria-busy');
    get('choose-image').disabled = false;
    get('choose-image').textContent = '选择图片';
  }
}
get('attach-image').addEventListener('click', sendImage);
get('expanded-attach').addEventListener('click', sendImage);
get('choose-image').addEventListener('click', sendImage);
