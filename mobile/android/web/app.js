// QingCode Android 入口：连接与项目状态、终端生命周期、输入分发和会话增删。
// 视图与弹窗拆在独立模块：dashboardView / pairingFlow / sessionDrawer / outputReader /
// composeStatus / terminalSettings / shortcutBar；纯逻辑放在 protocol / composer / keyLayout 等文件并有 Vitest 覆盖。
import {
  applyModifiers,
  consumeModifier,
  keySequence,
  mergeSessionName,
  nextModifierState,
  outputBatches,
  parsePairingLink,
  projectSourceLabel,
  rememberProject,
  renameProfileKeys,
  sessionName,
  terminalGridSize,
  terminalProfileChoices,
} from './protocol.js';
import { attachTerminalTouchScroll, attachTouchMouseGuard } from './terminalTouch.js';
import { attachKeyRepeat, attachPullToRefresh, attachSheetDrag } from './gestures.js';
import { composerInput, editDraft, isSlashDraft } from './composer.js';
import { attachTerminalHistory } from './terminalHistory.js';
import { attachTerminalSelection } from './terminalSelection.js';
import { createConnectionLatency, latencyText, TERMINAL_LATENCY_INTERVAL, HOME_LATENCY_INTERVAL } from './connectionLatency.js';
import { createWorkspaceState } from './workspaceState.js';
import { createNativeRpc } from './nativeRpc.js';
import { createTerminalInput } from './terminalInput.js';
import { createDesktopProtocol } from './desktopProtocol.js';
import { uploadTerminalImages } from './terminalImages.js';
import { get, message, setupDialogs, confirmAction } from './dom.js';
import { createDashboardView } from './dashboardView.js';
import { createPairingFlow } from './pairingFlow.js';
import { createOutputReader } from './outputReader.js';
import { createComposeStatus } from './composeStatus.js';
import { createSessionDrawer } from './sessionDrawer.js';
import { createTerminalSettings } from './terminalSettings.js';
import { createShortcutBar } from './shortcutBar.js';
import { attachCursorDrag } from './cursorDrag.js';
import { attachPinchZoom } from './pinchZoom.js';
import { attachTerminalLinks, phoneLink } from './terminalLinks.js';

const native = window.QingCodeNative;
const prefix = 'qingcode:mobile:';
const pages = { home: get('home-screen'), project: get('project-screen'), connection: get('connection-screen') };
const terminalScreen = get('terminal-screen');
const compose = get('compose');
const nativeRpc = createNativeRpc(native);
const rpc = nativeRpc.request;
window.qingReply = nativeRpc.receive;
const health = new Map();
let persistenceFailed = false;
const workspace = createWorkspaceState({ storage: localStorage, onError: () => { persistenceFailed = true; } });
const drafts = workspace.drafts;
const inputModes = new Map();
let inputMode = 'compose';
let disposeTouchGuard;
const keyRepeats = [];
const landscape = window.matchMedia('(orientation: landscape) and (min-width: 600px)');
let deviceLandscape = landscape.matches;
let nativeOrientation = false;
let keysPreference = localStorage.getItem(prefix + 'keys-collapsed');
let fullscreen = false;
let fullscreenEpoch = 0;
let profiles = [];
let profile = null;
let project = null;
let projects = [];
let loaded = false;
let profileEpoch = 0;
let page = 'home';
let sessions = [];
let selected = null;
let foreground = true;
// 电脑端终端配置（按连接缓存），弹窗打开时先显示缓存再刷新。
const terminalProfiles = new Map();
let terminalProfilesRequest = 0;
let viewEpoch = 0;
let term;
let fit;
let disposeTouchScroll;
let terminalHistory;
let terminalSelection;
let terminalLinks;
// 链接弹层当前显示的目标：{ url, open, note }。
let linkTarget = null;
let terminalReady = false;
// 修饰键三态 off / once / lock，lastTap 用于识别双击锁定。
const modifiers = { ctrl: 'off', alt: 'off' };
const lastTap = { ctrl: -Infinity, alt: -Infinity };
let busy = false;
let inputFailed = false;
let resizing = null;
let composing = false;
let editorComposing = false;
let fitting = null;
let sendingImage = false;
let imageEpoch = 0;
let fontToastTimer = null;
const inputTipKey = prefix + 'input-tip-seen';
// 配对与连接详情弹窗；在下方创建，视图回调中延迟读取。
let pairing = null;

const connectionLatency = createConnectionLatency({
  measure: address => rpc('latency', { profile: address }),
  onChange: renderLatency,
});

function remote(op, args = {}, address = profile?.id) {
  return rpc(op, { ...args, profile: address });
}
const desktopProtocol = createDesktopProtocol(remote);
const terminalInput = createTerminalInput({
  write: (target, data) => remote('input', { id: target.id, data }, target.address),
  isCurrent: target => target.epoch === viewEpoch && target.id === selected
    && target.address === profile?.id && terminalReady,
  onSuccess: () => {
    if (inputFailed) {
      inputFailed = false;
      get('terminal-status').textContent = '会话中';
    }
  },
  onError: error => {
    if (error.revoked) handleTerminalError(error);
    else {
      inputFailed = true;
      get('terminal-status').textContent = '输入提交结果未知，请检查终端输出。';
    }
  },
});

setupDialogs(dialog => dialog.id !== 'pair-dialog' || !get('pair-submit').disabled);

const dashboard = createDashboardView({
  state: {
    profile: () => profile,
    profiles: () => profiles,
    projects: () => projects,
    loaded: () => loaded,
    hostState,
  },
  lastProject,
  projectHistory,
  syncLatency,
  activate,
  openPair: (...args) => pairing.openPair(...args),
  openHost: item => pairing.openHost(item),
  openProject,
});

pairing = createPairingFlow({
  rpc,
  profiles: () => profiles,
  onPaired: async paired => {
    desktopProtocol.invalidate(paired);
    connectionLatency.invalidate(paired.id);
    putProfile(paired);
    await activate(paired);
  },
  moveProfile,
  putProfile,
  afterHostSaved: (updated, portChanged) => {
    if (profile?.id === updated.id && portChanged) void refreshProjects();
    dashboard.renderAll();
  },
  forgetProfile,
  renderLatency,
});

const reader = createOutputReader({ rpc, terminal: () => term, historyOpen: () => !!terminalHistory?.isOpen() });

const settings = createTerminalSettings({
  prefix,
  onFontSize: size => {
    if (term) {
      term.options.fontSize = size;
      fitTerminal();
    }
    // 只读历史沿用终端字号，缩放后同步。
    get('history-content').style.fontSize = size + 'px';
  },
  onColumns: () => fitTerminal(),
  onSendMode: () => updateComposerActions(),
});

const composeStatus = createComposeStatus({
  receipts: () => selected && profile ? workspace.recent(draftKey(selected)) : [],
  persistenceFailed: () => persistenceFailed,
  rawInput: () => inputMode === 'raw',
  draft: () => compose.value,
});

const drawer = createSessionDrawer({
  prefix,
  remote,
  state: {
    profile: () => profile,
    project: () => project,
    sessions: () => sessions,
    selected: () => selected,
    busy: () => busy,
    viewEpoch: () => viewEpoch,
    foreground: () => foreground,
  },
  setSessions: list => { sessions = list; },
  selectSession,
  endSession,
});

createShortcutBar({ prefix, onChange: () => updateComposerActions() });

window.qingVisibility = visible => {
  foreground = visible === true;
  if (foreground) drawer.wake();
  else drawer.sleep();
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
  const editing = pairing?.editingProfile();
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

function showPage(next) {
  page = next;
  terminalScreen.hidden = true;
  get('dashboard').hidden = false;
  for (const [name, section] of Object.entries(pages)) section.hidden = name !== next;
  for (const navButton of get('dashboard-nav').querySelectorAll('button')) {
    if (navButton.dataset.page === next) navButton.setAttribute('aria-current', 'page');
    else navButton.removeAttribute('aria-current');
  }
  syncLatency();
}

function returnToDashboard(next = page) {
  localStorage.removeItem(prefix + 'open');
  leaveTerminal();
  showPage(next);
}

window.qingBack = () => {
  for (const id of ['scan-dialog', 'confirm-dialog', 'rename-session-dialog', 'pair-confirm', 'host-dialog', 'pair-dialog', 'key-layout-dialog', 'keys-dialog', 'session-dialog', 'session-actions-dialog', 'session-drawer', 'new-session-dialog', 'image-dialog', 'link-dialog', 'terminal-menu-dialog', 'expanded-dialog', 'submissions-dialog', 'reader-dialog']) {
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

function hostState(item) {
  return health.get(item?.id) ?? 'saved';
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

function updateHost(state) {
  if (profile) health.set(profile.id, state);
  dashboard.renderAll();
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

window.qingLink = text => {
  try {
    const target = parsePairingLink(text);
    if (!terminalScreen.hidden) returnToDashboard('connection');
    else showPage('connection');
    pairing.openPairTarget(target);
  } catch (error) {
    if (!terminalScreen.hidden) returnToDashboard('connection');
    else showPage('connection');
    message('connection-error', error.message);
  }
};

/** 移除连接后清理手机上与这台电脑相关的全部记录。 */
function forgetProfile(item) {
  if (profile?.id === item.id) leaveTerminal();
  profiles = profiles.filter(saved => saved.id !== item.id);
  health.delete(item.id);
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix + 'session:' + item.id + ':') || key.startsWith(prefix + 'session-pins:' + item.id + ':')) {
      localStorage.removeItem(key);
    }
  }
  workspace.removeHost(item.id);
  localStorage.removeItem(prefix + 'project:' + item.id);
  localStorage.removeItem(prefix + 'recent-projects:' + item.id);
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
  dashboard.renderAll();
}

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
get('add-host').addEventListener('click', () => pairing.openPair());
get('refresh').addEventListener('click', () => { void refreshProjects(); });
get('search').addEventListener('input', () => dashboard.renderProjects());
get('resume').addEventListener('click', () => { void openProject(lastProject()); });
get('browse-projects').addEventListener('click', () => showPage('project'));
get('home-all-projects').addEventListener('click', () => showPage('project'));
get('home-reconnect').addEventListener('click', () => { void refreshProjects(); });
get('project-empty-action').addEventListener('click', () => {
  if (!profile) showPage('connection');
  else if (get('search').value.trim()) {
    get('search').value = '';
    dashboard.renderProjects();
  } else void refreshProjects();
});
get('home-action').addEventListener('click', () => {
  const state = hostState(profile);
  if (!profile) {
    if (profiles.length) showPage('connection');
    else pairing.openPair();
  } else if (state === 'expired') pairing.openPair(profile);
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

/**
 * 两种编辑目标：草稿（compose）先在手机编辑，点发送才提交；直发（raw）把每个按键立即发给终端。
 * 状态行用文字「草稿 / 直发」常驻标明，输入框配色、占位文字与键盘按钮选中态同步。
 */
function setRawKeyboard(enabled) {
  const nextMode = enabled ? 'raw' : 'compose';
  if (inputMode !== nextMode) cancelKeyRepeats();
  inputMode = nextMode;
  if (selected) inputModes.set(draftKey(selected), nextMode);
  if (term?.textarea) term.textarea.inputMode = enabled ? 'text' : 'none';
  get('keyboard').setAttribute('aria-pressed', String(enabled));
  get('keyboard').setAttribute('aria-label', enabled ? '切回草稿输入' : '切换为直发：按键立即发给终端');
  get('input-hint').textContent = enabled ? '终端实时输入 · 按键直接发送 · ⌫ 删除远端文字 · ↵ 确认' : '命令输入 · 空白发送回车 · ⌫ 编辑本地文字 · 斜杠命令先查看候选';
  get('input-mode').textContent = enabled ? '终端实时输入' : '命令输入';
  get('terminal-input-mode').textContent = enabled ? '直发' : '草稿';
  get('terminal-input-mode').dataset.mode = nextMode;
  get('keys-target').textContent = '编辑目标：' + (enabled ? '终端实时输入' : '手机草稿');
  compose.placeholder = enabled ? '直发中 · 按键立即发给终端' : '草稿 · 编辑后点发送';
  get('compose-form').dataset.mode = nextMode;
  get('input-mode').dataset.mode = nextMode;
  updateComposerActions();
}

function focusRawKeyboard() {
  if (!term) return;
  // WebView reads inputmode when creating the input connection.
  if (term.textarea === document.activeElement && term.textarea.inputMode === 'none') term.textarea.blur();
  setRawKeyboard(true);
  term.focus();
}

/** 首次进入终端时说明草稿 / 直发和新手势；点「知道了」或主动切换一次模式后不再显示。 */
function renderInputTip() {
  let seen = true;
  try { seen = localStorage.getItem(inputTipKey) === 'true'; } catch { /* 读不到时不打扰。 */ }
  get('input-tip').hidden = seen || terminalScreen.hidden;
}

function dismissInputTip() {
  if (get('input-tip').hidden) return;
  try { localStorage.setItem(inputTipKey, 'true'); } catch { /* 本次仍然关闭。 */ }
  get('input-tip').hidden = true;
}
get('input-tip-dismiss').addEventListener('click', dismissInputTip);

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
    composeStatus.renderSubmission();
  }
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
    const item = document.createElement('button');
    item.type = 'button';
    item.addEventListener('click', () => { get('submission-preview').value = text; });
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

get('terminal-menu').addEventListener('click', () => {
  get('terminal-menu-context').textContent = profile.name + ' / ' + project.name;
  get('terminal-menu-dialog').showModal();
});
for (const [id, action] of Object.entries({
  'menu-edit': openEditor,
  'menu-submissions': showSubmissions,
  'menu-read': () => reader.open(),
  'menu-sessions': () => { void drawer.open(); },
  'menu-new': () => { if (!busy) openNewSessionDialog(); },
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

function terminalControls() {
  return document.querySelectorAll('#special-keys button, #keys-dialog [data-key], #keyboard, #send, #attach-image, #expanded-attach');
}

function updateComposerActions() {
  const raw = inputMode === 'raw';
  const slash = !raw && settings.sendMode() !== 'enter' && isSlashDraft(compose.value);
  get('send').setAttribute('aria-label', raw ? '确认终端中的选择或命令' : slash ? '查看命令或技能候选，不发送回车' : compose.value ? '发送并回车' : '发送回车');
  get('send').querySelector('use').setAttribute('href', slash ? '#i-keyboard' : !raw && compose.value ? '#i-send' : '#i-return');
  get('send-label').textContent = raw ? '确认' : slash ? '候选' : '发送';
  get('completion-help').textContent = slash ? '先查看候选，再确认' : '↑↓ 选择 · ↵ 确认';
  composeStatus.renderNotes();
  for (const control of terminalControls()) {
    control.disabled = !terminalReady || composing || editorComposing || (['attach-image', 'expanded-attach'].includes(control.id) && sendingImage)
      || (control.dataset.key === 'clear' && (raw || !compose.value))
      || (!raw && /[\r\n]/.test(compose.value) && ['slash', 'tab', 'reference'].includes(control.dataset.key));
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
  const plan = composerInput(value, action, term?.modes.bracketedPasteMode, { autoEnter: action === 'submit' && settings.sendMode() === 'enter' });
  const key = selected && draftKey(selected);
  const text = raw ? '' : compose.value;
  let receipt;
  const onComplete = text ? state => {
    workspace.settle(key, receipt, state);
    if (selected && draftKey(selected) === key) composeStatus.renderSubmission();
  } : undefined;
  if (!plan || !sendInput(plan.data, { raw: plan.interactive, enter: plan.enter, onComplete })) return false;
  if (text) receipt = workspace.submit(key, text);
  // 草稿已提交，图片提示随之结束，不再显示「已就绪」。
  if (text && composeStatus.imageNote()) composeStatus.setImageNote('');
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
  composeStatus.renderSubmission();
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
  get('session-drawer').close();
  get('rename-session-dialog').close();
  cancelKeyRepeats();
  if (get('keys-dialog').open) get('keys-dialog').close();
  if (!preserveFullscreen) void setTerminalFullscreen(false);
  terminalSelection?.dispose();
  terminalSelection = undefined;
  terminalHistory?.dispose();
  terminalHistory = undefined;
  terminalLinks?.dispose();
  terminalLinks = undefined;
  if (get('link-dialog').open) get('link-dialog').close();
  terminalReady = false;
  terminalInput.flush();
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
  composeStatus.reset();
  get('scroll-bottom').hidden = true;
  get('input-tip').hidden = true;
  hideFontToast();
  disposeTouchScroll?.();
  disposeTouchScroll = undefined;
  disposeTouchGuard?.();
  disposeTouchGuard = undefined;
  term?.dispose();
  term = undefined;
  fit = undefined;
}

function makeTerminal() {
  term = new window.Terminal({
    allowProposedApi: false,
    fontSize: settings.fontSize(),
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
    touchToProgram: () => settings.touchMode() === 'program',
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
  terminalLinks = attachTerminalLinks(term, { onActivate: openTerminalLink });
  disposeTouchGuard = attachTouchMouseGuard(get('viewport'), {
    shouldBlock: () => settings.touchMode() === 'view' && term?.modes.mouseTrackingMode !== 'none',
    // 全屏程序拦截了鼠标事件，xterm 收不到点按；按触点坐标查找链接。
    onTap: event => {
      const url = event && terminalLinks?.linkAt(event.clientX, event.clientY);
      if (url) openTerminalLink(url);
      else term?.focus();
    },
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

/** 点终端里的链接：先弹出底部菜单确认打开或复制，避免点按终端时误跳浏览器。 */
function openTerminalLink(url) {
  if (!url || !project || terminalScreen.hidden) return;
  linkTarget = phoneLink(url, { computerHost: profile?.host, projectKind: project.kind });
  const rewritten = !!linkTarget.open && linkTarget.open !== linkTarget.url;
  get('link-url').textContent = linkTarget.open ?? linkTarget.url;
  get('link-original').textContent = rewritten ? '终端中为 ' + linkTarget.url : '';
  get('link-original').hidden = !rewritten;
  message('link-note', linkTarget.note);
  get('link-open').hidden = !linkTarget.open;
  get('link-status').textContent = '';
  term?.textarea?.blur();
  if (!get('link-dialog').open) get('link-dialog').showModal();
}

get('link-open').addEventListener('click', async () => {
  if (!linkTarget?.open) return;
  try {
    await rpc('open_link', { url: linkTarget.open });
    get('link-dialog').close();
  } catch (error) {
    get('link-status').textContent = error.message;
  }
});
get('link-copy').addEventListener('click', async () => {
  if (!linkTarget) return;
  try {
    await rpc('copy', { text: linkTarget.open ?? linkTarget.url });
    get('link-status').textContent = '链接已复制';
  } catch (error) {
    get('link-status').textContent = error.message;
  }
});

function updateTerminalSize() {
  get('terminal-size').textContent = term ? term.cols + ' × ' + term.rows : '';
}

function fitTerminal() {
  if (!term || !fit || terminalScreen.hidden) return;
  const terminalColumns = settings.columns();
  const screen = term.element.querySelector('.xterm-screen');
  const cellWidth = screen?.getBoundingClientRect().width / term.cols;
  const cellHeight = screen?.getBoundingClientRect().height / term.rows;
  const scrollbar = term.options.scrollback === 0 ? 0 : term.options.overviewRuler?.width || 14;
  get('viewport').dataset.columns = terminalColumns ? 'fixed' : 'fit';
  term.element.style.width = terminalColumns && cellWidth ? Math.ceil(terminalColumns * cellWidth + scrollbar) + 'px' : '100%';
  // FitAddon uses the parent's border-box size. Our padded viewport must use its
  // content box, otherwise a last row/column can be hidden behind the tools.
  const viewport = get('viewport');
  const padding = getComputedStyle(viewport);
  const size = terminalGridSize(
    viewport.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight) - scrollbar,
    viewport.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom),
    cellWidth, cellHeight, terminalColumns,
  );
  if (!size) return;
  if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);
}

get('scroll-bottom').addEventListener('click', () => { terminalHistory?.close(); term?.scrollToBottom(); });

new ResizeObserver(() => {
  clearTimeout(fitting);
  fitting = setTimeout(() => { fitting = null; fitTerminal(); }, 80);
}).observe(get('viewport'));

/** 双指缩放时在输出区上方短暂显示当前字号。 */
function showFontToast(size) {
  clearTimeout(fontToastTimer);
  const toast = get('font-toast');
  toast.textContent = '字号 ' + size + 'px';
  toast.hidden = false;
}

function hideFontToast(delay = 0) {
  clearTimeout(fontToastTimer);
  if (delay) fontToastTimer = setTimeout(() => { get('font-toast').hidden = true; }, delay);
  else get('font-toast').hidden = true;
}

attachPinchZoom(get('viewport').parentElement, {
  enabled: () => !!term && !terminalScreen.hidden,
  currentSize: () => settings.fontSize(),
  // 双指落下时停止单指滚动、惯性与长按选字计时，整个手势不发给终端程序。
  onStart: () => disposeTouchScroll?.cancel?.(),
  onPreview: size => {
    settings.setFontSize(size, { persist: false });
    showFontToast(size);
  },
  onCommit: (size, info) => {
    if (!info?.unchanged) settings.setFontSize(size);
    hideFontToast(info?.unchanged ? 0 : 900);
  },
});

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
  inputFailed = false;
  terminalReady = state === 'online';
  get('expanded-send').disabled = !terminalReady;
  get('terminal-status').textContent = text;
  get('terminal-dot').dataset.state = state;
  get('terminal-retry').hidden = !retry;
  for (const control of terminalControls()) {
    control.disabled = !terminalReady || (['attach-image', 'expanded-attach'].includes(control.id) && sendingImage);
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
  // 头部只留一行：省略地址，完整来源在项目列表与会话设置中可见。
  get('terminal-host').textContent = [profile.name, projectSourceLabel({ ...item, host: '' })].join(' · ');
  get('dashboard').hidden = true;
  terminalScreen.hidden = false;
  void syncTerminalFullscreen();
  makeTerminal();
  drawer.render();
  renderInputTip();
  terminalState('正在连接终端…');
  try {
    const list = await remote('sessions', { project: item.id });
    if (epoch !== viewEpoch) return;
    sessions = list;
    drawer.prunePins(list);
    const previous = localStorage.getItem(sessionKey(item.id));
    const existing = sessions.find(session => session.id === previous)
      ?? sessions.find(session => !session.exit)
      ?? sessions[0];
    if (existing) selectSession(existing);
    else if (resumeOnly) returnToDashboard('home');
    else await createSession(epoch, 'default');
  } catch (error) {
    if (epoch === viewEpoch) handleTerminalError(error);
  } finally {
    busy = false;
  }
}

async function createSession(epoch, terminalProfile = null) {
  // 启动命令由电脑端按配置 id 解析并在新会话启动时执行，手机不再向终端输入命令。
  const args = { project: project.id, ...dimensions() };
  if (terminalProfile) args.terminal_profile = terminalProfile;
  const session = await remote('create', args);
  if (epoch !== viewEpoch) return;
  sessions.push(session);
  selectSession(session);
}

function renderTerminalProfiles(choices, state = '') {
  const list = get('terminal-profiles');
  list.replaceChildren(...choices.map(choice => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'secondary';
    if (choice.id) option.dataset.profile = choice.id;
    const name = document.createElement('span');
    name.textContent = choice.name;
    option.append(name);
    if (!choice.trusted) {
      const hint = document.createElement('small');
      hint.textContent = '需先在电脑上信任';
      option.append(hint);
    }
    option.addEventListener('click', () => {
      // 电脑端创建时仍会校验信任；这里提前提示，避免关闭弹窗后才报错。
      if (!choice.trusted) message('terminal-profiles-error', `请先在电脑上新建一次「${choice.name}」终端并选择「信任此配置」。`);
      else void newSession(choice.id);
    });
    return option;
  }));
  list.setAttribute('aria-busy', String(state === 'loading'));
  message('terminal-profiles-error', state === 'error' ? '无法读取电脑端终端配置，已仅显示普通终端。' : '');
}

async function openNewSessionDialog() {
  const address = profile?.id;
  const cached = terminalProfiles.get(address);
  renderTerminalProfiles(cached ?? terminalProfileChoices(null), cached ? '' : 'loading');
  get('new-session-dialog').showModal();
  const request = ++terminalProfilesRequest;
  try {
    const capabilities = await desktopProtocol.capabilities(profile);
    const supported = capabilities === null || capabilities.features.includes('terminal_profiles');
    const choices = terminalProfileChoices(supported ? await remote('terminal_profiles', {}, address) : null);
    terminalProfiles.set(address, choices);
    if (request === terminalProfilesRequest && profile?.id === address) renderTerminalProfiles(choices);
  } catch {
    // 旧版电脑端不认识该请求：保留缓存或普通终端。
    if (request === terminalProfilesRequest && profile?.id === address) renderTerminalProfiles(cached ?? terminalProfileChoices(null), cached ? '' : 'error');
  }
}

function selectSession(session) {
  get('session-dialog').close();
  get('session-drawer').close();
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
  dashboard.renderHome();
  makeTerminal();
  drawer.render();
  renderInputTip();
  terminalState('正在接入终端…');
  composeStatus.renderSubmission();
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
      const current = sessions.find(item => item.id === session.id);
      if (current && mergeSessionName(current, data)) drawer.render();
      if (data.chunks.length) reader.notifyOutput();
      latest = false;
      terminalHistory?.update(data.historyBefore, data.historyAvailable);
      next = data.next;
      if (data.reset) {
        term.reset();
        term.writeln('[较早的输出已超出电脑端缓存]');
      }
      // 相邻字节块合并成一次写入：一批动画帧只渲染最后的画面。
      for (const chunk of outputBatches(data.chunks)) {
        if (epoch !== viewEpoch) return;
        const view = term;
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
        if (current && !current.exit) {
          current.exit = data.exit;
          drawer.render();
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
        drawer.render();
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

function sendInput(value, { raw = false, enter = '', onComplete } = {}) {
  if (!terminalReady) return false;
  if (!raw && (modifiers.ctrl !== 'off' || modifiers.alt !== 'off')) {
    value = applyModifiers(value, { ctrl: modifiers.ctrl !== 'off', alt: modifiers.alt !== 'off' });
    consumeModifiers();
  }
  if (!terminalInput.enqueue(value, { id: selected, address: profile?.id, epoch: viewEpoch }, { enter, onComplete })) {
    get('terminal-status').textContent = '输入过长，请分段粘贴。';
    return false;
  }
  return true;
}

get('back').addEventListener('click', () => returnToDashboard());
get('show-sessions').addEventListener('click', () => { void drawer.open(); });
get('manage-sessions').addEventListener('click', () => get('session-dialog').showModal());
get('drawer-settings').addEventListener('click', () => { get('session-drawer').close(); get('session-dialog').showModal(); });
get('drawer-new-session').addEventListener('click', () => { if (!busy) { get('session-drawer').close(); openNewSessionDialog(); } });
get('terminal-retry').addEventListener('click', () => { void openProject(project); });
get('new-session').addEventListener('click', () => { if (!busy) openNewSessionDialog(); });

async function newSession(terminalProfile) {
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
    drawer.render();
    get('new-session-dialog').close();
    await createSession(epoch, terminalProfile);
  } catch (error) {
    if (epoch === viewEpoch) {
      if (wasReady && !error.revoked) get('terminal-status').textContent = error.message;
      else handleTerminalError(error);
    }
  } finally {
    busy = false;
  }
}

async function endSession(id) {
  const target = sessions.find(item => item.id === id);
  if (busy || !target) return;
  const epoch = viewEpoch;
  const address = profile.id;
  const ended = target.exit;
  busy = true;
  drawer.pause();
  message('session-error', '');
  drawer.render();
  try {
    if (!await confirmAction(ended ? '移除会话？' : '关闭会话？',
      `「${sessionName(target)}」` + (ended ? '的输出将从列表中移除。' : '中的 Shell 和前台任务将被关闭。'), ended ? '移除' : '关闭')) return;
    if (epoch !== viewEpoch) return;
    await remote('end', { id }, address);
    if (epoch !== viewEpoch) return;
    sessions = sessions.filter(item => item.id !== id);
    drawer.savePins(drawer.pins().filter(pin => pin !== id));
    if (selected === id) {
      compose.value = '';
      if (sessions.length) {
        selectSession(sessions.find(item => !item.exit) ?? sessions[0]);
        get('session-drawer').showModal();
        get('show-sessions').setAttribute('aria-expanded', 'true');
      } else {
        localStorage.removeItem(sessionKey(project.id));
        returnToDashboard('home');
      }
    }
    drafts.delete(draftKey(id));
  } catch (error) {
    if (epoch === viewEpoch) {
      if (error.revoked) handleTerminalError(error);
      else message('session-error', error.message);
    }
  } finally {
    busy = false;
    drawer.render();
    drawer.scheduleRefresh();
  }
}

get('end-all-sessions').addEventListener('click', async () => {
  if (busy || !project || !sessions.length) return;
  let epoch = viewEpoch;
  const address = profile.id;
  const projectId = project.id;
  const previous = selected;
  busy = true;
  drawer.pause();
  message('session-error', '');
  drawer.render();
  try {
    // Refresh before confirmation, then end only the exact sessions shown there.
    const targets = await remote('sessions', { project: projectId }, address);
    if (epoch !== viewEpoch) return;
    sessions = targets;
    drawer.render();
    if (!targets.length) {
      get('session-drawer').close();
      localStorage.removeItem(sessionKey(projectId));
      returnToDashboard('home');
      return;
    }
    if (!await confirmAction('结束全部会话？',
      `将结束「${profile.name} / ${project.name}」的全部 ${targets.length} 个手机会话，关闭其中的 Shell 和前台任务，并移除会话输出。其他项目和桌面终端不受影响。`, '结束全部')) return;
    if (epoch !== viewEpoch) return;
    get('session-drawer').close();
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
      get('session-drawer').showModal();
      get('show-sessions').setAttribute('aria-expanded', 'true');
    }
  } catch (error) {
    if (epoch === viewEpoch) {
      if (error.revoked) handleTerminalError(error);
      else message('session-error', error.message);
    }
  } finally {
    busy = false;
    drawer.render();
    drawer.scheduleRefresh();
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
  } else if (key === 'clear-input') {
    clearModifiers();
    const buffer = term?.buffer.active;
    let row = buffer ? buffer.baseY + buffer.cursorY : 0;
    let line = buffer?.getLine(row);
    let inputLine = line?.translateToString(true) ?? '';
    // 宽度不足造成的视觉折行仍属于同一输入行；不扫描历史输出猜程序。
    while (line?.isWrapped && row > 0) {
      line = buffer.getLine(--row);
      inputLine = (line?.translateToString(true) ?? '') + inputLine;
    }
    sendInput(keySequence(key, { inputLine: buffer?.type === 'alternate' ? '' : inputLine }), { raw: true });
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

/**
 * 在输入框上左右拖动移动光标（类似 iOS 空格键触控板）：草稿模式移动手机草稿的光标，
 * 直发模式向终端发送 ← / →。竖向拖动仍用于滚动多行草稿。
 */
attachCursorDrag(compose, {
  enabled: () => terminalReady && !composing && !editorComposing,
  step: () => inputMode === 'raw' ? 14 : 10,
  onStart: () => {
    cancelKeyRepeats();
    get('compose-form').dataset.dragging = 'true';
    if (inputMode === 'compose' && document.activeElement !== compose) compose.focus({ preventScroll: true });
  },
  onSteps: steps => {
    const direction = steps < 0 ? 'left' : 'right';
    if (inputMode === 'raw') {
      const sequence = keySequence(direction, { applicationCursor: term?.modes.applicationCursorKeysMode });
      sendInput(sequence.repeat(Math.abs(steps)), { raw: true });
    } else {
      for (let index = 0; index < Math.abs(steps); index += 1) editCompose(direction);
    }
  },
  onEnd: () => { delete get('compose-form').dataset.dragging; },
});

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
  // 主动切换过一次模式，说明用户已了解两种输入方式。
  dismissInputTip();
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
    dashboard.renderAll();
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
  get('expanded-attach').disabled = true;
  get('choose-image').disabled = true;
  message('image-error', '');
  let inserted = 0;
  let count = 0;
  const current = () => epoch === viewEpoch && selected === id && attempt === imageEpoch;
  try {
    const capabilities = await desktopProtocol.capabilities(profile);
    if (capabilities && !capabilities.features.includes('images')) throw new Error('电脑端不支持图片上传，请更新电脑端 QingCode。');
    if (!current()) return;
    await uploadTerminalImages({
      rpc, remote, address, id, compression: settings.compression(), isCurrent: current,
      onProgress: (index, total) => {
        count = total;
        get('choose-image').textContent = '正在上传…';
        composeStatus.setImageNote(count === 1 ? '图片上传中…' : `图片上传中… ${index}/${count}`);
      },
      onInsert: path => {
        compose.value += (compose.value && !/\s$/.test(compose.value) ? ' ' : '') + path + ' ';
        drafts.set(draftKey(id), compose.value);
        resizeComposer();
        if (get('expanded-dialog').open) get('expanded-compose').value = compose.value;
        inserted += 1;
      },
    });
    if (!current() || !count) return;
    if (get('image-dialog').open) get('image-dialog').close();
    composeStatus.setImageNote(count === 1 ? '✓ 图片已插入' : `✓ 已插入 ${inserted} 张图片`, { state: 'done', ttl: 2500 });
    compose.focus();
  } catch (error) {
    if (epoch === viewEpoch && selected === id && attempt === imageEpoch) {
      if (error.revoked) handleTerminalError(error);
      else {
        composeStatus.setImageNote('⚠ 图片上传失败', { state: 'error', ttl: 6000 });
        message('image-error', count > 1
          ? `已插入 ${inserted}/${count} 张图片。${error.message} 请重新选择剩余未上传的图片。`
          : error.message);
        if (!get('image-dialog').open) get('image-dialog').showModal();
      }
    }
  } finally {
    if (composeStatus.imageNote()?.state === 'busy' && attempt === imageEpoch) composeStatus.setImageNote('');
    sendingImage = false;
    get('attach-image').disabled = !terminalReady;
    get('attach-image').removeAttribute('aria-busy');
    get('choose-image').disabled = false;
    get('choose-image').textContent = '选择图片';
    updateComposerActions();
  }
}
get('attach-image').addEventListener('click', sendImage);
get('expanded-attach').addEventListener('click', sendImage);
get('choose-image').addEventListener('click', sendImage);

void initialize();
