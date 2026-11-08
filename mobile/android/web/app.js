// QingCode Android 入口：连接与项目状态、终端生命周期、输入分发和会话增删。
// 视图与弹窗拆在独立模块：dashboardView / pairingFlow / sessionDrawer / outputReader /
// composeStatus / terminalSettings / shortcutBar；纯逻辑放在 protocol / composer / keyLayout 等文件并有 Vitest 覆盖。
import {
  applyModifiers,
  consumeModifier,
  keySequence,
  mergeSessionActivity,
  mergeSessionList,
  mergeSessionName,
  nextModifierState,
  outputBatches,
  parsePairingLink,
  projectSourceLabel,
  rememberProject,
  renameProfileKeys,
  sessionName,
  summarizeSessionBatch,
  terminalGridSize,
  terminalProfileChoices,
} from './protocol.js';
import { attachTerminalTouchScroll, attachTouchMouseGuard, dispatchLineWheel, dispatchVirtualClick, dispatchVirtualMouse } from './terminalTouch.js';
import { attachTerminalJog } from './terminalJog.js';
import { heldTerminalRows, heldRowOffset, keyboardLikelyOpen } from './terminalHold.js';
import { homeSessionsEnabled, onSessionPrefsChange, setHomeSessionsEnabled } from './sessionPrefs.js';
import { attachKeyRepeat, attachPullToRefresh, attachSheetDrag } from './gestures.js';
import { composerInput, editDraft, isSlashDraft } from './composer.js';
import { attachTerminalHistory } from './terminalHistory.js';
import { attachTerminalScrollbar } from './terminalScrollbar.js';
import { attachTerminalSelection } from './terminalSelection.js';
import { createConnectionLatency, isFreshLatency, latencyText, TERMINAL_LATENCY_INTERVAL, HOME_LATENCY_INTERVAL } from './connectionLatency.js';
import { createWorkspaceState } from './workspaceState.js';
import { createNativeRpc } from './nativeRpc.js';
import { createTerminalInput } from './terminalInput.js';
import { createDesktopProtocol } from './desktopProtocol.js';
import { uploadTerminalImages } from './terminalImages.js';
import { get, message, setupDialogs, confirmAction, replayAnimation } from './dom.js';
import { setupSelectMenus } from './selectMenu.js';
import { createDashboardView } from './dashboardView.js';
import { createPairingFlow } from './pairingFlow.js';
import { createOutputReader } from './outputReader.js';
import { createComposeStatus } from './composeStatus.js';
import { createSessionDrawer } from './sessionDrawer.js';
import { createSessionOverview } from './sessionOverview.js';
import { createTerminalSettings } from './terminalSettings.js';
import { createShortcutBar } from './shortcutBar.js';
import { attachCursorDrag } from './cursorDrag.js';
import { attachPinchZoom } from './pinchZoom.js';
import { attachTerminalLinks, phoneLink } from './terminalLinks.js';
import { createUpdateView } from './updateView.js';
import { attachMouseMode } from './mouseMode.js';
import { attachHistorySelection } from './historySelection.js';
import { createTerminalFontLoader } from './terminalFont.js';
import { attachTerminalRenderer } from './terminalRenderer.js';
import { createSessionWatch } from './sessionWatch.js';
import { dateLocale, initLocale, loadLocalePreference, saveLocalePreference, t, translateDocument } from './i18n.js';

const native = window.QingCodeNative;
const loadTerminalFont = createTerminalFontLoader(document.fonts);
document.documentElement.lang = initLocale(localStorage, navigator) === 'en' ? 'en' : 'zh-CN';
translateDocument(document.body);
// 语言切换：立即生效。原生 WebView 拦截了页面内跳转，location.reload() 不会真正重载，
// 因此改为就地重译静态文案并重绘各视图，同时保留当前页面与终端会话。
function renderLanguageChoice() {
  const choice = loadLocalePreference(localStorage);
  for (const button of document.querySelectorAll('#app-language [data-locale]')) {
    button.setAttribute('aria-checked', String(button.dataset.locale === choice));
  }
}
renderLanguageChoice();
get('app-language').addEventListener('click', event => {
  const button = event.target.closest?.('[data-locale]');
  if (!button || button.getAttribute('aria-checked') === 'true') return;
  saveLocalePreference(localStorage, button.dataset.locale);
  renderLanguageChoice();
  applyLocale(initLocale(localStorage, navigator));
});

/** 切换语言后重译静态文案并重绘带占位符的动态文案；瞬时提示保持原样，下次更新时即为新语言。 */
function applyLocale(value) {
  document.documentElement.lang = value === 'en' ? 'en' : 'zh-CN';
  translateDocument(document.body);
  dashboard.renderAll();
  homeOverview.render();
  drawer.render();
  renderLatency();
  setRawKeyboard(inputMode === 'raw');
  updates.render();
  if (profile && selected) drawer.render();
}
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
// 平板宽屏（含横屏平板和较宽的分屏窗口）：会话侧栏常驻在终端左侧。
const wideLayout = window.matchMedia('(min-width: 840px)');
let deviceLandscape = landscape.matches;
let nativeOrientation = false;
let keysPreference = localStorage.getItem(prefix + 'keys-collapsed');
// 接入实体键盘时默认收起快捷键栏；期间手动展开只在本次连接键盘内有效，不写入偏好。
let hardKeyboard = false;
let hardKeysExpanded = false;
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
let terminalScrollbar;
let terminalJog;
let terminalMouse;
/** 鼠标模式下虚拟指针在各会话里的位置（画面内相对比例），切回会话时恢复。 */
const mousePositions = new Map();
/** 虚拟鼠标在历史面板（只读 DOM 文本）里的选区。 */
const historySelection = attachHistorySelection(get('history-content'));
/** 软键盘打开时保留的终端行数下，实际可见的行数；0 表示没有保留。 */
let heldVisibleRows = 0;
/** 当前窗口宽度下见过的最大高度，用来判断软键盘是否打开。 */
const windowHeights = { width: 0, max: 0 };
/** 用户正在往上阅读时收到的整屏快照先不重画（重画会清空手机滚动记录），回到底部后再接最新画面。 */
let deferredLatest = false;
let unsupportedScrollGesture = null;
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
// 关闭单个会话时只在逻辑上加锁，列表不变暗，避免确认和请求期间闪一下。
let endingSession = false;
let inputFailed = false;
let resizing = null;
let composing = false;
let editorComposing = false;
let fitting = null;
let sendingImage = false;
let imageEpoch = 0;
let fontToastTimer = null;
const inputTipKey = prefix + 'input-tip-seen';
const gestureGuideKey = prefix + 'gesture-guide-seen';
let terminalRenderer;
// 配对与连接详情弹窗；在下方创建，视图回调中延迟读取。
let pairing = null;

let latencyFlashedAt = null;
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
      get('terminal-status').textContent = t('会话中');
    }
  },
  onError: error => {
    if (error.revoked) handleTerminalError(error);
    else {
      inputFailed = true;
      get('terminal-status').textContent = t('输入提交结果未知，请检查终端输出。');
    }
  },
});

setupDialogs(dialog => dialog.id !== 'pair-dialog' || !get('pair-submit').disabled);
setupSelectMenus();

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
  onRenderer: () => terminalRenderer?.sync(),
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
    locked: () => busy && !endingSession,
    viewEpoch: () => viewEpoch,
    foreground: () => foreground,
    projects: () => projects,
    history: () => projectHistory(),
    lastSession: projectId => lastSessionOf(projectId),
    allSupported: async () => {
      if (!profile) return false;
      const value = await desktopProtocol.capabilities(profile);
      return !!value?.features.includes('all_sessions');
    },
  },
  setSessions: list => { sessions = list; },
  selectSession,
  endSession,
  openOverviewSession: session => openOverviewSession(session, drawer.overview),
  endOverviewSessions: list => endOverviewSessions(list, drawer.overview),
});

// 工作台首页「全部会话」：首页可见、App 在前台且电脑在线时定时刷新；与抽屉的「全部」共用组件。
const HOME_SESSIONS_INTERVAL = 5000;
const HOME_SESSIONS_LIMIT = 8;
// 首页会话不超过这个数时收起搜索与筛选，只留「运行中优先」与「管理」。
const HOME_SESSIONS_COMPACT = 4;
let homeSessionsTimer = null;
let homeSessionsLoading = false;
let homeSessionsEpoch = 0;
let homeSessionsSupported = false;
const homeOverview = createSessionOverview({
  root: get('home-session-overview'),
  limit: HOME_SESSIONS_LIMIT,
  compactBelow: HOME_SESSIONS_COMPACT,
  state: {
    profile: () => profile,
    projects: () => projects,
    history: () => projectHistory(),
    current: () => null,
    selected: () => null,
    lastSession: projectId => lastSessionOf(projectId),
    busy: () => busy,
  },
  open: session => openOverviewSession(session, homeOverview),
  end: list => endOverviewSessions(list, homeOverview),
  onChange: () => renderHomeSessions(),
});

/** 该项目上次接入的会话（只读手机记录）。 */
function lastSessionOf(projectId) {
  return profile ? localStorage.getItem(prefix + 'session:' + profile.id + ':' + projectId) : null;
}

function homeSessionsVisible() {
  return homeSessionsEnabled() && !!profile && page === 'home' && terminalScreen.hidden && !get('dashboard').hidden
    && foreground && !document.hidden && hostState(profile) === 'online';
}

/** 设置中未打开、没有会话（且不在多选中）或旧电脑端时隐藏整块，首页只保留最近打开。 */
function renderHomeSessions() {
  const count = homeOverview.count();
  get('home-session-count').textContent = String(count);
  get('home-sessions').hidden = !homeSessionsEnabled() || !homeSessionsSupported || !profile || hostState(profile) !== 'online'
    || (!count && !homeOverview.isSelecting());
}

// 设置 → 工作台：首页「全部会话」默认显示；关闭后停止刷新，重新打开时立即读取。
get('home-sessions-setting').value = homeSessionsEnabled() ? 'on' : 'off';
get('home-sessions-setting').addEventListener('change', () => setHomeSessionsEnabled(get('home-sessions-setting').value === 'on'));
onSessionPrefsChange(() => {
  get('home-sessions-setting').value = homeSessionsEnabled() ? 'on' : 'off';
  renderHomeSessions();
  if (homeSessionsEnabled()) void refreshHomeSessions();
  else {
    clearTimeout(homeSessionsTimer);
    homeSessionsTimer = null;
  }
});

async function refreshHomeSessions() {
  clearTimeout(homeSessionsTimer);
  homeSessionsTimer = null;
  if (!homeSessionsVisible() || homeSessionsLoading) return;
  if (busy) {
    homeSessionsTimer = setTimeout(refreshHomeSessions, HOME_SESSIONS_INTERVAL);
    return;
  }
  homeSessionsLoading = true;
  const epoch = ++homeSessionsEpoch;
  const address = profile.id;
  try {
    const capabilities = await desktopProtocol.capabilities(profile);
    if (epoch !== homeSessionsEpoch || profile?.id !== address) return;
    homeSessionsSupported = !!capabilities?.features.includes('all_sessions');
    if (!homeSessionsSupported) {
      homeOverview.clear();
      return;
    }
    const list = await remote('sessions', {}, address);
    if (epoch !== homeSessionsEpoch || profile?.id !== address || busy) return;
    homeOverview.setError('');
    homeOverview.setList(list, address);
  } catch (error) {
    if (epoch === homeSessionsEpoch && profile?.id === address) homeOverview.setError(error.message);
  } finally {
    homeSessionsLoading = false;
    renderHomeSessions();
    if (homeSessionsSupported && homeSessionsVisible() && !homeSessionsTimer) {
      homeSessionsTimer = setTimeout(refreshHomeSessions, HOME_SESSIONS_INTERVAL);
    }
  }
}

/** 首页可见性变化后启动或停止刷新；离开首页时退出多选并丢弃在途结果。 */
function syncHomeSessions() {
  if (homeSessionsVisible()) {
    if (!homeSessionsTimer && !homeSessionsLoading) void refreshHomeSessions();
  } else {
    clearTimeout(homeSessionsTimer);
    homeSessionsTimer = null;
    homeSessionsEpoch += 1;
    homeOverview.reset();
    renderHomeSessions();
  }
}
document.addEventListener('visibilitychange', syncHomeSessions);

// 平板双栏默认收起，用户展开后记在这台设备上。
let sessionsDockPreferred = localStorage.getItem(prefix + 'sessions-docked') === 'true';

/** 平板宽屏、在终端页且用户选择展开时常驻会话侧栏，其余情况恢复为可收起的抽屉。 */
function syncSessionDock() {
  drawer.dock(tabletLayout() && sessionsDockPreferred && !terminalScreen.hidden && !!project);
  get('show-sessions').setAttribute('aria-label', drawer.isDocked() ? t('收起会话侧栏') : t('打开会话侧栏'));
}

/** 侧栏入口：平板上切换双栏并保存；手机上打开抽屉。 */
function toggleSessions({ expandOnly = false } = {}) {
  if (!tabletLayout()) { void drawer.open(); return; }
  const next = expandOnly || !drawer.isDocked();
  sessionsDockPreferred = next;
  try { localStorage.setItem(prefix + 'sessions-docked', String(next)); } catch { /* 仅为显示偏好。 */ }
  syncSessionDock();
}

/**
 * 窗口宽 ≥840px 且设备最短边 ≥600px（对应 Android sw600dp）才算平板宽屏：
 * 横屏手机宽度也可能超过 840px；按屏幕而非视口高度判断，弹出输入法时不会来回切换布局。
 */
function tabletLayout() {
  return wideLayout.matches && Math.min(screen.width, screen.height) >= 600;
}
window.addEventListener('resize', syncSessionDock);

createShortcutBar({ prefix, onChange: () => updateComposerActions() });

const sessionWatch = createSessionWatch({
  rpc,
  prefix,
  capabilities: () => profile ? desktopProtocol.capabilities(profile) : Promise.resolve(null),
  notice: text => showTerminalToast(text, 4000),
  // 其他首次说明还在显示时先不问，避免同时堆两条。
  tipBlocked: () => !get('input-tip').hidden || get('gesture-guide').open || terminalScreen.hidden,
});

/** 点通知进入对应会话。目标来自 Intent，只接受已配对的电脑和当前仍存在的项目。 */
async function openSessionTarget(target) {
  const item = profiles.find(saved => saved.id === target?.address);
  if (!item || typeof target.project !== 'string' || typeof target.session !== 'string') return;
  localStorage.setItem(prefix + 'session:' + item.id + ':' + target.project, target.session);
  const current = !terminalScreen.hidden && profile?.id === item.id && project?.id === target.project;
  const existing = current && sessions.find(session => session.id === target.session);
  if (existing) {
    await selectSession(existing);
    return;
  }
  if (!await activate(item)) return;
  const destination = projects.find(candidate => candidate.id === target.project);
  if (destination) await openProject(destination);
}
window.qingOpenSession = target => { void openSessionTarget(target); };
// 在线更新：版本信息、后台检查与安装包下载（原生层经 window.qingUpdate 回传进度）。
const updates = createUpdateView({ rpc });
window.qingUpdate = event => updates.receive(event);

window.qingVisibility = visible => {
  foreground = visible === true;
  if (foreground) drawer.wake();
  else drawer.sleep();
  syncHomeSessions();
  if (!visible) saveDraft();
  connectionLatency.setForeground(visible === true);
  if (foreground) terminalRenderer?.wake();
};

function syncLatency() {
  connectionLatency.setTarget(profile && hostState(profile) === 'online' ? profile : null,
    terminalScreen.hidden ? HOME_LATENCY_INTERVAL : TERMINAL_LATENCY_INTERVAL);
  renderLatency();
}

function renderLatency() {
  const snapshot = connectionLatency.getSnapshot();
  const value = latencyText(snapshot);
  // 每次探测成功闪一下状态圆点和延迟值；语言切换等重绘不闪，失败也不闪。
  if (isFreshLatency(snapshot, latencyFlashedAt)) {
    latencyFlashedAt = snapshot.checkedAt;
    if (!terminalScreen.hidden) for (const id of ['terminal-dot', 'terminal-latency']) replayAnimation(get(id), 'ping-flash');
  }
  get('terminal-latency').textContent = t('电脑 {value}', { value });
  get('terminal-latency').setAttribute('aria-label', t('手机到电脑往返延迟 {value}', { value }));
  get('home-latency').textContent = profile && hostState(profile) === 'online' ? t(' · 电脑 {value}', { value }) : '';
  const editing = pairing?.editingProfile();
  if (!editing || editing.id !== profile?.id) {
    get('host-latency').textContent = t('延迟仅检测当前连接的电脑。');
    return;
  }
  const state = {
    idle: t('尚未测量。'), failed: t('本次检测未获得结果。'), stale: t('结果已过期，等待更新。'),
    unsupported: t(t('当前电脑端不支持延迟检测，请更新电脑端 QingCode。')), ready: '',
  }[snapshot.state];
  const time = snapshot.checkedAt === null ? '' : t('最近测量 {time}。', { time: new Date(snapshot.checkedAt).toLocaleTimeString(dateLocale(), { hour12: false }) });
  get('host-latency').textContent = t('手机到电脑往返延迟：{value}。', { value }) + time + state + t('不包含电脑到远端及终端程序处理耗时。');
}

function showPage(next) {
  page = next;
  terminalScreen.hidden = true;
  syncSessionDock();
  get('dashboard').hidden = false;
  for (const [name, section] of Object.entries(pages)) section.hidden = name !== next;
  for (const navButton of get('dashboard-nav').querySelectorAll('button')) {
    if (navButton.dataset.page === next) navButton.setAttribute('aria-current', 'page');
    else navButton.removeAttribute('aria-current');
  }
  syncLatency();
  if (next === 'home') void refreshHomeSessions();
  else syncHomeSessions();
}

function returnToDashboard(next = page) {
  localStorage.removeItem(prefix + 'open');
  leaveTerminal();
  showPage(next);
}

window.qingBack = () => {
  for (const id of ['select-dialog', 'gesture-guide', 'update-dialog', 'scan-dialog', 'confirm-dialog', 'rename-session-dialog', 'pair-confirm', 'host-dialog', 'pair-dialog', 'key-layout-dialog', 'keys-dialog', 'settings-dialog', 'session-dialog', 'session-actions-dialog', 'session-drawer', 'new-session-dialog', 'image-dialog', 'link-dialog', 'terminal-menu-dialog', 'expanded-dialog', 'submissions-dialog', 'reader-dialog']) {
    const dialog = get(id);
    if (!dialog.open || (id === 'session-drawer' && drawer.isDocked())) continue;
    if (id !== 'pair-dialog' || !get('pair-submit').disabled) dialog.close('cancel');
    return true;
  }
  if (!terminalScreen.hidden) {
    if (terminalSelection?.close()) return true;
    if (terminalMouse?.isActive()) { terminalMouse.set(false); return true; }
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
  syncHomeSessions();
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
get('open-settings').addEventListener('click', () => get('settings-dialog').showModal());
// 叠在终端设置上打开：返回时回到终端设置，与快捷键栏一致。
get('open-settings-from-terminal').addEventListener('click', () => get('settings-dialog').showModal());
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
  get('keyboard').setAttribute('aria-label', enabled ? t('切回草稿输入') : t('切换为直发：按键立即发给终端'));
  get('input-hint').textContent = enabled ? t('终端实时输入 · 按键直接发送 · ⌫ 删除远端文字 · ↵ 确认') : t('命令输入 · 空白发送回车 · ⌫ 编辑本地文字 · 斜杠命令先查看候选');
  get('input-mode').textContent = enabled ? t('终端实时输入') : t('命令输入');
  get('terminal-input-mode').textContent = enabled ? t('直发') : t('草稿');
  get('terminal-input-mode').dataset.mode = nextMode;
  get('keys-target').textContent = t('编辑目标：{target}', { target: enabled ? t('终端实时输入') : t('手机草稿') });
  compose.placeholder = enabled ? t('直发中 · 按键立即发给终端') : t('草稿 · 编辑后点发送');
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

/** 第一次接入终端时说明一次手势；无论怎样关闭都不再显示。 */
function showGestureGuide() {
  let seen = true;
  try { seen = localStorage.getItem(gestureGuideKey) === 'true'; } catch { /* 读不到时不打扰。 */ }
  if (seen || terminalScreen.hidden || document.querySelector('dialog[open]')) return;
  get('gesture-guide').showModal();
}
get('gesture-guide').addEventListener('close', () => {
  try { localStorage.setItem(gestureGuideKey, 'true'); } catch { /* 本次仍然关闭。 */ }
});

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
    get('expanded-save-status').textContent = t('手机保存失败，请复制并保留原文。');
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
    const state = { sending: t('发送中'), received: t('电脑已接收'), unknown: t('提交结果未知') }[receipt.state];
    add(state + ' ' + new Date(receipt.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), receipt.text);
  }
  for (const room of workspace.recoverable(profile.id, project.id, key)) {
    if (room.draft) add(t('本项目其他会话草稿'), room.draft);
    for (const receipt of [...room.receipts].reverse()) add(t('本项目其他会话提交 · {state}', { state: { sending: t('发送中'), received: t('电脑已接收'), unknown: t('结果未知') }[receipt.state] }), receipt.text);
  }
  get('submissions-dialog').showModal();
}

get('terminal-menu').addEventListener('click', () => {
  get('menu-mouse').textContent = terminalMouse?.isActive() ? t('退出鼠标模式') : t('鼠标模式');
  get('menu-mouse').disabled = !terminalMouse;
  get('terminal-menu-context').textContent = profile.name + ' / ' + project.name;
  get('terminal-menu-dialog').showModal();
});
for (const [id, action] of Object.entries({
  'menu-edit': openEditor,
  'menu-submissions': showSubmissions,
  'menu-read': () => reader.open(),
  'menu-mouse': toggleMouseMode,
  'menu-sessions': () => toggleSessions({ expandOnly: true }),
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
  try { await rpc('copy', { text: get('submission-preview').value }); get('submission-feedback').textContent = t('原文已复制'); }
  catch (error) { get('submission-feedback').textContent = t(error.message); }
});

function terminalControls() {
  return document.querySelectorAll('#special-keys button, #keys-dialog [data-key], #keyboard, #send, #attach-image, #expanded-attach');
}

function updateComposerActions() {
  const raw = inputMode === 'raw';
  const slash = !raw && settings.sendMode() !== 'enter' && isSlashDraft(compose.value);
  get('send').setAttribute('aria-label', raw ? t('确认终端中的选择或命令') : slash ? t('查看命令或技能候选，不发送回车') : compose.value ? t('发送并回车') : t('发送回车'));
  get('send').querySelector('use').setAttribute('href', slash ? '#i-keyboard' : !raw && compose.value ? '#i-send' : '#i-return');
  get('send-label').textContent = raw ? t('确认') : slash ? t('候选') : t('发送');
  get('completion-help').textContent = slash ? t('先查看候选，再确认') : t('↑↓ 选择 · ↵ 确认');
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
  const collapsed = hardKeyboard ? !hardKeysExpanded : keysPreference === null ? deviceLandscape : keysPreference === 'true';
  cancelKeyRepeats();
  get('special-keys').hidden = collapsed;
  get('toggle-keys').setAttribute('aria-expanded', String(!collapsed));
  get('toggle-keys').querySelector('span').textContent = collapsed ? t('展开按键') : t('收起按键');
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
    get('terminal-status').textContent = t(error.message);
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
window.qingHardKeyboard = present => {
  if (hardKeyboard === (present === true)) return;
  hardKeyboard = present === true;
  hardKeysExpanded = false;
  renderShortcutVisibility();
};
get('toggle-keys').addEventListener('click', () => {
  if (hardKeyboard) {
    hardKeysExpanded = get('toggle-keys').getAttribute('aria-expanded') !== 'true';
  } else {
    keysPreference = String(get('toggle-keys').getAttribute('aria-expanded') === 'true');
    localStorage.setItem(prefix + 'keys-collapsed', keysPreference);
  }
  renderShortcutVisibility();
});
renderShortcutVisibility();

function leaveTerminal({ preserveFullscreen = false, keepDrawer = false } = {}) {
  if (!keepDrawer) drawer.close();
  get('rename-session-dialog').close();
  cancelKeyRepeats();
  if (get('keys-dialog').open) get('keys-dialog').close();
  if (!preserveFullscreen) void setTerminalFullscreen(false);
  terminalMouse?.dispose();
  terminalMouse = undefined;
  terminalSelection?.dispose();
  terminalSelection = undefined;
  terminalHistory?.dispose();
  terminalHistory = undefined;
  terminalScrollbar?.dispose();
  terminalScrollbar = undefined;
  terminalJog?.dispose();
  terminalJog = undefined;
  heldVisibleRows = 0;
  deferredLatest = false;
  terminalLinks?.dispose();
  terminalLinks = undefined;
  terminalRenderer?.dispose();
  terminalRenderer = undefined;
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
  get('terminal-empty').hidden = true;
  get('input-tip').hidden = true;
  sessionWatch.hideTip();
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
    // term.unicode 属于 proposed API；不开启就无法切换到 Unicode 11 宽度。
    allowProposedApi: true,
    fontSize: settings.fontSize(),
    lineHeight: 1.2,
    // 系统等宽字体缺字时回退到内置符号字体（见 app.css @font-face）。
    fontFamily: "'QingCode Symbols', monospace",
    scrollback: 10000,
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
  // 与桌面终端和电脑端屏幕快照使用同样的字符宽度，否则 emoji 会让全屏程序错位。
  term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(get('viewport'));
  terminalRenderer = attachTerminalRenderer(term, { Addon: window.WebglAddon?.WebglAddon, enabled: settings.gpuRender });
  const historyEpoch = viewEpoch;
  const historySession = selected;
  terminalHistory = attachTerminalHistory({
    term, get,
    onClose: () => disposeTouchScroll?.cancel?.(),
    onUnsupportedScroll: gesture => {
      if (gesture !== undefined && gesture === unsupportedScrollGesture) return;
      unsupportedScrollGesture = gesture;
      showTerminalToast(t('此全屏程序未开启鼠标滚动，可用 PgUp / PgDn 翻页'), 2200);
    },
    loadPage: async before => {
      // formatted：新版电脑端返回带基本颜色的历史；旧版忽略该参数，仍返回纯文本。
      const data = await remote('history', { id: historySession, before, formatted: true });
      if (historyEpoch !== viewEpoch) throw new Error(t('会话已切换'));
      return data;
    },
  });
  terminalSelection = attachTerminalSelection({
    term, container: get('viewport').parentElement,
    copyText: async text => { await rpc('copy', { text }); showTerminalToast(t('已复制'), 1200); },
    onStart: () => disposeTouchScroll?.cancel?.(),
    canQuote: () => terminalReady && !!term?.modes.bracketedPasteMode,
  });
  disposeTouchScroll = attachTerminalTouchScroll(term.element, {
    onLongPress: point => terminalSelection?.start(point),
    // 惯性同样交给原始终端：普通终端滚本地记录，开了鼠标的全屏程序收到滚轮；不支持滚动的全屏程序不滑行。
    canInertia: () => terminalHistory?.isOpen() || !!term && (term.buffer.active.type === 'normal' || term.modes.mouseTrackingMode !== 'none'),
    // 程序开了鼠标上报：按字符行高把手指位移换成整格滚轮，滑动时顺带露出右侧变速滑块。
    programWheel: () => programMouse() ? cellHeight() : 0,
    onProgramWheel: () => terminalJog?.reveal(),
  });
  terminalLinks = attachTerminalLinks(term, { onActivate: openTerminalLink });
  disposeTouchGuard = attachTouchMouseGuard(get('viewport'), {
    // 鼠标模式下点按只移动虚拟指针，点击改由虚拟鼠标的左右键发出，所以触摸带出的鼠标事件一律拦下。
    shouldBlock: () => !!terminalMouse?.isActive() || settings.touchMode() === 'view' && term?.modes.mouseTrackingMode !== 'none',
    // 全屏程序拦截了鼠标事件，xterm 收不到点按；按触点坐标查找链接。
    onTap: event => {
      if (terminalMouse?.isActive()) return;
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
    terminalMouse?.refresh();
    updateTerminalSize();
    clearTimeout(resizing);
    resizing = setTimeout(sendSize, 120);
  });
  const historyScroll = get('history-scroll');
  terminalScrollbar = attachTerminalScrollbar(get('viewport').parentElement, {
    metrics: () => {
      if (terminalHistory?.isOpen()) {
        return { total: historyScroll.scrollHeight, visible: historyScroll.clientHeight, offset: historyScroll.scrollTop };
      }
      const buffer = term?.buffer.active;
      if (!buffer || buffer.type !== 'normal' || !buffer.baseY) return null;
      return { total: buffer.baseY + term.rows, visible: term.rows, offset: buffer.viewportY };
    },
    scrollTo: offset => {
      if (terminalHistory?.isOpen()) historyScroll.scrollTop = offset;
      else term?.scrollToLine(Math.round(offset));
    },
    onLongPress: toggleMouseMode,
  });
  terminalJog = attachTerminalJog(get('viewport').parentElement, {
    scroll: ticks => sendProgramWheel(ticks),
    // 一页约等于三分之一屏的格数（程序一格通常滚 1–3 行）。
    page: direction => sendProgramWheel(direction * Math.max(3, Math.round((term?.rows ?? 24) / 3))),
    onLongPress: toggleMouseMode,
  });
  const mouseKey = selected && draftKey(selected);
  terminalMouse = attachMouseMode(get('viewport').parentElement, get('viewport'), {
    extraTargets: [get('terminal-history')],
    label: t('鼠标'),
    exitLabel: t('退出鼠标模式'),
    leftLabel: t('鼠标左键'),
    rightLabel: t('鼠标右键'),
    dragLabel: t('拖动以移动鼠标指针'),
    // 历史面板盖住 xterm 时指针在面板里活动；面板是自由滚动的文字，不对应 xterm 字格，不画高亮。
    screenRect: () => terminalHistory?.isOpen()
      ? get('history-scroll').getBoundingClientRect()
      : term?.element?.querySelector('.xterm-screen')?.getBoundingClientRect() ?? get('viewport').getBoundingClientRect(),
    grid: () => term && !terminalHistory?.isOpen() ? { cols: term.cols, rows: term.rows } : null,
    position: () => mouseKey ? mousePositions.get(mouseKey) : undefined,
    savePosition: ratio => { if (mouseKey) mousePositions.set(mouseKey, ratio); },
    onChange: active => {
      terminalScrollbar?.setPinned(active);
      terminalJog?.setPinned(active);
      showTerminalToast(active ? t('鼠标模式：拖动鼠标移动指针，按住左键滑动选中，右键打开菜单；点「鼠标」退出') : t('已退出鼠标模式'), active ? 2600 : 1200);
    },
    onClick: (point, button) => {
      hideFontToast();
      void rpc('haptic').catch(() => {});
      // 右键在任何画面都打开菜单：多数全屏程序不响应右键，发给程序的右键放在菜单里。
      if (button === 2) { terminalMouse?.showMenu(mouseMenuItems(point)); return; }
      if (terminalHistory?.isOpen()) {
        if (historySelection.start(point)) showHistorySelectionMenu();
        return;
      }
      // 开了鼠标上报的程序：在指针尖端派发真实的左键点击，由 xterm 编码后发给程序。
      if (programMouse()) { sendVirtualMouse(screen => dispatchVirtualClick(screen, point, 0)); return; }
      // 普通终端：左键选中指针下的词。
      terminalSelection?.start(point);
    },
    // 按住左键拖动：历史面板和普通终端延伸选区；能收到拖动的程序收到按下、移动和抬起。
    onDrag: (phase, point) => {
      if (terminalHistory?.isOpen()) {
        if (phase === 'down') void rpc('haptic').catch(() => {});
        historySelection.drag(phase, point);
        if (phase === 'up' && historySelection.text()) showHistorySelectionMenu();
        return;
      }
      if (programReceivesDrag()) {
        const type = phase === 'down' ? 'mousedown' : phase === 'move' ? 'mousemove' : 'mouseup';
        sendVirtualMouse(screen => dispatchVirtualMouse(screen, type, point, { button: 0, buttons: phase === 'up' ? 0 : 1 }));
      } else {
        if (phase === 'down') void rpc('haptic').catch(() => {});
        terminalSelection?.drag(phase, point);
      }
    },
  });
  term.onWriteParsed(() => {
    terminalJog?.setActive(programMouse());
    if (heldVisibleRows) placeHeldRows();
  });
  term.onScroll(() => {
    terminalScrollbar?.update();
    if (terminalHistory?.isOpen()) return;
    const buffer = term.buffer.active;
    const reading = buffer.viewportY < buffer.baseY;
    get('scroll-bottom').hidden = !reading && !deferredLatest;
  });
}

/** 点终端里的链接：先弹出底部菜单确认打开或复制，避免点按终端时误跳浏览器。 */
function openTerminalLink(url) {
  if (!url || !project || terminalScreen.hidden) return;
  linkTarget = phoneLink(url, { computerHost: profile?.host, projectKind: project.kind });
  const rewritten = !!linkTarget.open && linkTarget.open !== linkTarget.url;
  get('link-url').textContent = linkTarget.open ?? linkTarget.url;
  get('link-original').textContent = rewritten ? t('终端中为 {url}', { url: linkTarget.url }) : '';
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
    get('link-status').textContent = t(error.message);
  }
});
get('link-copy').addEventListener('click', async () => {
  if (!linkTarget) return;
  try {
    await rpc('copy', { text: linkTarget.open ?? linkTarget.url });
    get('link-status').textContent = t('链接已复制');
  } catch (error) {
    get('link-status').textContent = t(error.message);
  }
});

/** 程序是否开着鼠标上报（Codex、opencode 等全屏程序）：此时滑动作为滚轮交给程序。 */
/** 长按右侧滑块或「… → 鼠标模式」：切换鼠标模式并轻震提示。 */
function toggleMouseMode() {
  if (!terminalMouse) return;
  terminalMouse.toggle();
  void rpc('haptic').catch(() => {});
}

/**
 * 向终端画面派发虚拟鼠标事件。xterm 在 mousedown 时会聚焦输入框，若原本没开键盘，派发后立即失焦，避免弹出软键盘。
 */
function sendVirtualMouse(dispatch) {
  const screen = term?.element?.querySelector('.xterm-screen');
  if (!screen || !terminalReady) return;
  const focused = document.activeElement === term.textarea;
  dispatch(screen);
  if (!focused && document.activeElement === term.textarea) term.textarea.blur();
}

/** 普通终端右键「粘贴」：读手机剪贴板，按终端粘贴（支持括号粘贴模式）写入。 */
async function pastePhoneClipboard() {
  const terminal = term;
  const epoch = viewEpoch;
  if (!terminal || !terminalReady) return;
  try {
    const text = await rpc('clipboard');
    if (epoch !== viewEpoch || terminal !== term || !terminalReady) return;
    if (text) terminal.paste(String(text));
    else showTerminalToast(t('剪贴板为空'), 1400);
  } catch (error) {
    if (epoch === viewEpoch) showTerminalToast(t(error.message || '无法打开手机剪贴板。'), 1800);
  }
}

/** 虚拟鼠标右键菜单：按当前画面列出可做的操作。 */
function mouseMenuItems(point) {
  const inHistory = !!terminalHistory?.isOpen();
  const selectedText = inHistory ? historySelection.text() : term?.getSelection();
  const items = [];
  if (selectedText) items.push({ label: t('复制'), run: () => { void copyMouseSelection(selectedText); } });
  if (inHistory) {
    items.push({ label: t('选中'), run: () => { if (historySelection.start(point)) showHistorySelectionMenu(); } });
    items.push({ label: t('回到最新'), run: () => get('scroll-bottom').click() });
    return items;
  }
  items.push({ label: t('选中'), run: () => terminalSelection?.start(point) });
  items.push({ label: t('粘贴'), run: () => { void pastePhoneClipboard(); } });
  if (programMouse()) items.push({ label: t('发送右键'), run: () => sendVirtualMouse(screen => dispatchVirtualClick(screen, point, 2)) });
  return items;
}

/** 历史面板没有实时终端的选区工具栏：选中后在鼠标旁给出复制和取消。 */
function showHistorySelectionMenu() {
  const text = historySelection.text();
  if (!text) return;
  terminalMouse?.showMenu([
    { label: t('复制'), run: () => { void copyMouseSelection(text); } },
    { label: t('取消'), run: () => historySelection.clear() },
  ]);
}

async function copyMouseSelection(text) {
  try {
    await rpc('copy', { text });
    showTerminalToast(t('已复制'), 1200);
  } catch (error) {
    showTerminalToast(t(error.message || '复制失败，请重试'), 1800);
  }
}

/** 程序是否请求了拖动上报：只报点击的程序（x10 / vt200）收不到拖动，拖选仍在手机本地完成。 */
function programReceivesDrag() {
  const mode = term?.modes.mouseTrackingMode;
  return mode === 'drag' || mode === 'any';
}

function programMouse() {
  return !!term && term.modes.mouseTrackingMode !== 'none';
}

function cellHeight() {
  const screen = term?.element?.querySelector('.xterm-screen');
  return screen && term.rows ? screen.getBoundingClientRect().height / term.rows : 0;
}

/** 变速滑块和翻页按钮：在终端画面偏左上处派发按行滚轮（opencode 等按指针所在面板滚动）。 */
function sendProgramWheel(ticks) {
  const screen = term?.element?.querySelector('.xterm-screen');
  if (!screen || !ticks || !terminalReady || !programMouse()) return;
  const rect = screen.getBoundingClientRect();
  dispatchLineWheel(screen, ticks, { x: rect.left + rect.width * .4, y: rect.top + rect.height * .4 });
}

function keyboardOpen() {
  if (window.innerWidth !== windowHeights.width) {
    windowHeights.width = window.innerWidth;
    windowHeights.max = 0;
  }
  windowHeights.max = Math.max(windowHeights.max, window.innerHeight);
  return keyboardLikelyOpen(window.innerHeight, windowHeights.max);
}

/** 保留行数时把画面上移，露出光标所在行（输入框通常在底部）。 */
function placeHeldRows() {
  if (!term?.element) return;
  const rows = heldRowOffset(term.rows, heldVisibleRows, term.buffer.active.cursorY);
  term.element.style.marginTop = rows ? -(rows * cellHeight()) + 'px' : '';
}

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
  // 软键盘弹出、输入框变高时不缩小终端行数：改尺寸会让 Claude Code / Codex 重绘，
  // 旧画面被挤进滚动记录，历史里出现重复的状态栏和输入框。
  const rows = heldTerminalRows({ fitRows: size.rows, currentRows: term.rows, sameColumns: size.cols === term.cols, keyboardOpen: keyboardOpen() });
  heldVisibleRows = rows > size.rows ? size.rows : 0;
  if (size.cols !== term.cols || rows !== term.rows) term.resize(size.cols, rows);
  placeHeldRows();
}

get('scroll-bottom').addEventListener('click', () => { terminalHistory?.close(); term?.scrollToBottom(); });
// 历史面板打开 / 关闭时指针换了活动区域，重新摆放并更新字格高亮。
new MutationObserver(() => terminalMouse?.refresh()).observe(get('terminal-history'), { attributes: true, attributeFilter: ['hidden'] });
get('history-scroll').addEventListener('scroll', () => terminalScrollbar?.update(), { passive: true });

/** 用户是否在往上阅读：此时新输出不把画面拉回底部，也不用整屏快照清掉滚动记录。 */
function readingBack() {
  if (terminalHistory?.isOpen() || terminalScrollbar?.dragging()) return true;
  const buffer = term?.buffer.active;
  return !!buffer && buffer.viewportY < buffer.baseY;
}

new ResizeObserver(() => {
  clearTimeout(fitting);
  fitting = setTimeout(() => { fitting = null; fitTerminal(); }, 80);
}).observe(get('viewport'));

/** 双指缩放时在输出区上方短暂显示当前字号。 */
function showFontToast(size) {
  showTerminalToast(t('字号 {size}px', { size }));
}

/** 输出区上方的短提示；delay 毫秒后自动隐藏（0 表示由调用方隐藏）。 */
function showTerminalToast(text, delay = 0) {
  clearTimeout(fontToastTimer);
  const toast = get('font-toast');
  toast.textContent = text;
  toast.hidden = false;
  if (delay) hideFontToast(delay);
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
  get('terminal-status').textContent = t(text);
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
    terminalState(t(error.message), 'offline', retry);
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
  syncSessionDock();
  void syncTerminalFullscreen();
  terminalState(t('正在连接终端…'));
  try {
    await loadTerminalFont();
    if (epoch !== viewEpoch) return;
    makeTerminal();
    drawer.render();
    renderInputTip();
    const list = await remote('sessions', { project: item.id });
    if (epoch !== viewEpoch) return;
    sessions = mergeSessionList(list, sessions);
    drawer.prunePins(list);
    const previous = localStorage.getItem(sessionKey(item.id));
    const existing = sessions.find(session => session.id === previous)
      ?? sessions.find(session => !session.exit)
      ?? sessions[0];
    if (existing) await selectSession(existing);
    else if (resumeOnly) returnToDashboard('home');
    else showEmptyProject();
  } catch (error) {
    if (epoch === viewEpoch) handleTerminalError(error);
  } finally {
    busy = false;
    // 常驻侧栏在打开项目期间已显示，结束忙碌后立即恢复按钮可用。
    if (drawer.isDocked()) drawer.render();
  }
}

// 进入没有终端的项目时不再自动新建，只显示空状态，由用户点「新建终端」。
function showEmptyProject() {
  terminalState(t('暂无终端'));
  get('terminal-empty').hidden = false;
}

async function createSession(epoch, terminalProfile = null) {
  // 启动命令由电脑端按配置 id 解析并在新会话启动时执行，手机不再向终端输入命令。
  const args = { project: project.id, ...dimensions() };
  if (terminalProfile) args.terminal_profile = terminalProfile;
  const session = await remote('create', args);
  if (epoch !== viewEpoch) return;
  sessions.push(session);
  await selectSession(session);
}

function renderTerminalProfiles(choices, state = '') {
  const list = get('terminal-profiles');
  list.replaceChildren(...choices.map(choice => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'secondary';
    if (choice.id) option.dataset.profile = choice.id;
    const name = document.createElement('span');
    name.textContent = t(choice.name);
    option.append(name);
    if (!choice.trusted) {
      const hint = document.createElement('small');
      hint.textContent = t('需先在电脑上信任');
      option.append(hint);
    }
    option.addEventListener('click', () => {
      // 电脑端创建时仍会校验信任；这里提前提示，避免关闭弹窗后才报错。
      if (!choice.trusted) message('terminal-profiles-error', t('请先在电脑上新建一次「{name}」终端并选择「信任此配置」。', { name: choice.name }));
      else void newSession(choice.id);
    });
    return option;
  }));
  list.setAttribute('aria-busy', String(state === 'loading'));
  message('terminal-profiles-error', state === 'error' ? t(t('无法读取电脑端终端配置，已仅显示普通终端。')) : '');
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

async function selectSession(session, { keepDrawer = false } = {}) {
  get('terminal-empty').hidden = true;
  get('session-dialog').close();
  if (!keepDrawer) drawer.close();
  if (selected === session.id) return;
  leaveTerminal({ preserveFullscreen: true, keepDrawer });
  const epoch = viewEpoch;
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
  terminalState(t('正在接入终端…'));
  await loadTerminalFont();
  if (epoch !== viewEpoch) return;
  makeTerminal();
  drawer.render();
  renderInputTip();
  showGestureGuide();
  sessionWatch.seen(profile.id, session.id);
  composeStatus.renderSubmission();
  void poll(session, epoch);
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
    if (deferredLatest) {
      // 阅读中暂停接收：回到底部后直接取最新画面，跳过的输出仍可在电脑端历史里上滑查看。
      if (readingBack()) {
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      deferredLatest = false;
      latest = true;
    }
    try {
      const data = await remote('poll', { id: session.id, from: next, latest, tail: true });
      if (epoch !== viewEpoch) return;
      const current = sessions.find(item => item.id === session.id);
      const renamed = current ? mergeSessionName(current, data) : false;
      if (mergeSessionActivity(current, data) || renamed) drawer.render();
      if (current?.programBusy) void sessionWatch.busySeen();
      if (data.chunks.length) reader.notifyOutput();
      latest = false;
      terminalHistory?.update(data.historyBefore, data.historyAvailable);
      next = data.next;
      if (data.reset) {
        term.reset();
        term.writeln(t('[较早的输出已超出电脑端缓存]'));
      }
      // 相邻字节块合并成一次写入：一批动画帧只渲染最后的画面。
      for (const chunk of outputBatches(data.chunks)) {
        if (epoch !== viewEpoch) return;
        const view = term;
        if (chunk.screen && readingBack()) {
          deferredLatest = true;
          get('scroll-bottom').hidden = false;
          break;
        }
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
      if (data.chunks.length && readingBack()) {
        get('scroll-bottom').querySelector('span').textContent = t('有新输出 · 回到最新');
      }
      if (epoch !== viewEpoch) return;
      if (data.exit) {
        if (current && !current.exit) {
          current.exit = data.exit;
          drawer.render();
        }
        terminalState(data.exit.disconnected ? t('电脑到远端的终端连接已中断') : t('会话已结束 · 退出码 {code}', { code: data.exit.exitCode }));
        if (data.more) continue;
        return;
      }
      if (!terminalReady) {
        terminalState(t('会话中'), 'online');
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
        terminalState(t('原会话已不存在 · 草稿保留，可新建终端恢复'), 'offline');
        return;
      }
      terminalState(t('连接中断，正在接回会话…'), 'offline');
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
    get('terminal-status').textContent = t('输入过长，请分段粘贴。');
    return false;
  }
  return true;
}

get('back').addEventListener('click', () => returnToDashboard());
get('show-sessions').addEventListener('click', () => toggleSessions());
get('manage-sessions').addEventListener('click', () => get('session-dialog').showModal());
get('drawer-settings').addEventListener('click', () => { drawer.close(); get('session-dialog').showModal(); });
get('drawer-new-session').addEventListener('click', () => { if (!busy) { drawer.close(); openNewSessionDialog(); } });
get('terminal-retry').addEventListener('click', () => { void openProject(project); });
get('new-session').addEventListener('click', () => { if (!busy) openNewSessionDialog(); });
// 空状态与右上角「＋」、会话抽屉共用「新建会话」弹层，可先选普通终端或电脑端终端配置。
get('terminal-empty-new').addEventListener('click', () => { if (!busy) openNewSessionDialog(); });

async function newSession(terminalProfile) {
  if (busy) return;
  busy = true;
  const epoch = viewEpoch;
  const wasReady = terminalReady;
  if (!selected) terminalState(t('正在新建终端…'));
  try {
    // Pick up sessions whose creation response may have been lost.
    const list = await remote('sessions', { project: project.id });
    if (epoch !== viewEpoch) return;
    sessions = mergeSessionList(list, sessions);
    drawer.render();
    get('new-session-dialog').close();
    await createSession(epoch, terminalProfile);
  } catch (error) {
    if (epoch === viewEpoch) {
      if (wasReady && !error.revoked) get('terminal-status').textContent = t(error.message);
      else handleTerminalError(error);
    }
  } finally {
    busy = false;
    if (drawer.isDocked()) drawer.render();
  }
}

async function endSession(id) {
  const target = sessions.find(item => item.id === id);
  if (busy || !target) return;
  const epoch = viewEpoch;
  const address = profile.id;
  const ended = target.exit;
  busy = true;
  endingSession = true;
  drawer.pause();
  message('session-error', '');
  drawer.render();
  try {
    if (!await confirmAction(ended ? t('移除会话？') : t('关闭会话？'),
      t(ended ? '「{name}」的输出将从列表中移除。' : '「{name}」中的 Shell 和前台任务将被关闭。', { name: sessionName(target) }), ended ? t('移除') : t('关闭'))) return;
    if (epoch !== viewEpoch) return;
    await remote('end', { id }, address);
    if (epoch !== viewEpoch) return;
    sessions = sessions.filter(item => item.id !== id);
    drawer.savePins(drawer.pins().filter(pin => pin !== id));
    // 先收起这一行，再切换终端；抽屉全程不关，不会滑出再滑入。
    drawer.render();
    if (selected === id) {
      compose.value = '';
      if (sessions.length) {
        await selectSession(sessions.find(item => !item.exit) ?? sessions[0], { keepDrawer: true });
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
    endingSession = false;
    drawer.render();
    drawer.scheduleRefresh();
  }
}

/** 纵览中点选会话：终端页当前项目直接切换，其他项目（或在首页时）打开该项目再接入这个会话。 */
async function openOverviewSession(target, view) {
  if (busy || !profile) return;
  const projectId = target.project?.id;
  if (!terminalScreen.hidden && projectId === project?.id) {
    const existing = sessions.find(item => item.id === target.id);
    if (existing) await selectSession(existing);
    return;
  }
  const destination = projects.find(item => item.id === projectId);
  if (!destination) {
    view.setError(t('电脑端已没有项目「{name}」，只能关闭其中的会话。', { name: target.project?.name ?? projectId }));
    return;
  }
  view.setError('');
  localStorage.setItem(sessionKey(destination.id), target.id);
  await openProject(destination);
}

/** 纵览中某个会话的确认说明：项目 / 会话名，其他设备创建的运行中会话额外注明。 */
function overviewConfirmText(target) {
  const ended = !!target.exit;
  const name = (target.project?.name ?? '') + ' / ' + sessionName(target);
  const text = t(ended ? '「{name}」的输出将从列表中移除。' : '「{name}」中的 Shell 和前台任务将被关闭。', { name });
  return !ended && target.ownDevice === false
    ? text + t('该会话由 {device} 创建。', { device: target.deviceName || t('其他设备') }) : text;
}

/**
 * 纵览中关闭一个或多个会话（可跨项目）。终端页当前项目的单个会话沿用 endSession（收起动画与接回剩余会话）；
 * 其余情况确认后逐个结束，失败的保留并提示，不自动重试。view 为发起操作的纵览，用于显示错误。
 */
async function endOverviewSessions(targets, view) {
  if (busy || !profile || !targets.length) return;
  const inTerminal = !terminalScreen.hidden;
  if (targets.length === 1 && inTerminal && targets[0].project?.id === project?.id) {
    await endSession(targets[0].id);
    return;
  }
  const epoch = viewEpoch;
  const address = profile.id;
  const single = targets.length === 1;
  busy = true;
  // 单个关闭确认期间列表不变暗，与抽屉逐项关闭一致。
  endingSession = single;
  drawer.pause();
  clearTimeout(homeSessionsTimer);
  homeSessionsTimer = null;
  homeSessionsEpoch += 1;
  view.setError('');
  drawer.render();
  homeOverview.render();
  try {
    let title, text, action;
    if (single) {
      const [target] = targets;
      title = target.exit ? t('移除会话？') : t('关闭会话？');
      text = overviewConfirmText(target);
      action = target.exit ? t('移除') : t('关闭');
    } else {
      const summary = summarizeSessionBatch(targets);
      title = t('关闭 {n} 个会话？', { n: summary.total });
      text = [
        summary.running ? t('将关闭 {n} 个运行中会话的 Shell 和前台任务。', { n: summary.running }) : '',
        summary.others ? t('其中 {n} 个由其他设备创建。', { n: summary.others }) : '',
        summary.ended ? t('将移除 {n} 个已结束会话的输出。', { n: summary.ended }) : '',
        t('涉及 {n} 个项目。', { n: summary.projects }),
      ].filter(Boolean).join('');
      action = t('关闭 {n} 个', { n: summary.total });
    }
    if (!await confirmAction(title, text, action)) return;
    if (profile?.id !== address) return;
    const removed = new Set();
    let failed = 0;
    for (const item of targets) {
      try {
        await remote('end', { id: item.id }, address);
        removed.add(item.id);
        drafts.delete(draftKey(item.id));
      } catch (error) {
        if (error.revoked) throw error;
        failed += 1;
      }
    }
    if (profile?.id !== address) return;
    drawer.overview.remove(removed);
    homeOverview.remove(removed);
    if (failed) view.setError(t('已关闭 {ended} 个会话，{failed} 个未确认关闭，请核对后重试。', { ended: removed.size, failed }));
    if (inTerminal && epoch === viewEpoch && project && removed.size) {
      const projectId = project.id;
      sessions = sessions.filter(item => !removed.has(item.id));
      drawer.savePins(drawer.pins().filter(pin => !removed.has(pin)));
      if (removed.has(selected)) {
        compose.value = '';
        if (sessions.length) {
          await selectSession(sessions.find(item => !item.exit) ?? sessions[0], { keepDrawer: true });
        } else {
          localStorage.removeItem(sessionKey(projectId));
          leaveTerminal({ preserveFullscreen: true, keepDrawer: true });
          showEmptyProject();
        }
      }
    }
  } catch (error) {
    if (profile?.id === address) {
      if (error.revoked && inTerminal) handleTerminalError(error);
      else if (error.revoked) updateHost('expired');
      else view.setError(error.message);
    }
  } finally {
    busy = false;
    endingSession = false;
    drawer.render();
    drawer.scheduleRefresh();
    homeOverview.render();
    syncHomeSessions();
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
    sessions = mergeSessionList(targets, sessions);
    drawer.render();
    if (!targets.length) {
      drawer.close();
      localStorage.removeItem(sessionKey(projectId));
      returnToDashboard('home');
      return;
    }
    if (!await confirmAction(t('结束全部会话？'),
      t('将结束「{host} / {project}」的全部 {n} 个手机会话，关闭其中的 Shell 和前台任务，并移除会话输出。其他项目和桌面终端不受影响。', { host: profile.name, project: project.name, n: targets.length }), t('结束全部'))) return;
    if (epoch !== viewEpoch) return;
    drawer.close();
    // Pause polling and input while the confirmed terminals are being closed.
    leaveTerminal({ preserveFullscreen: true });
    epoch = viewEpoch;
    terminalState(t('正在结束全部会话…'));
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
      await selectSession(sessions.find(item => item.id === previous) ?? sessions.find(item => !item.exit) ?? sessions[0]);
      message('session-error', t('已结束 {ended} 个会话，{failed} 个未确认结束，请核对后重试。', { ended: ended.size, failed: failed.length }));
      if (!drawer.isDocked()) {
        get('session-drawer').showModal();
        get('show-sessions').setAttribute('aria-expanded', 'true');
      }
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
    onRefresh: async () => {
      const ok = await refreshProjects();
      if (screen === 'home-screen') await refreshHomeSessions();
      return ok;
    },
  });
}
for (const sheet of document.querySelectorAll('dialog.sheet')) {
  attachSheetDrag(sheet, sheet.querySelector('.sheet-handle'), () => sheet.close('cancel'));
}

async function initialize() {
  // 更新检查独立进行，不阻塞连接与终端恢复。
  void updates.start();
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
    const target = await rpc('pendingSession');
    if (target) {
      await openSessionTarget(target);
      return;
    }
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
    if (capabilities && !capabilities.features.includes('images')) throw new Error(t('电脑端不支持图片上传，请更新电脑端 QingCode。'));
    if (!current()) return;
    await uploadTerminalImages({
      rpc, remote, address, id, compression: settings.compression(), isCurrent: current,
      onProgress: (index, total) => {
        count = total;
        get('choose-image').textContent = t('正在上传…');
        composeStatus.setImageNote(count === 1 ? t('图片上传中…') : t('图片上传中… {index}/{count}', { index, count }));
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
    composeStatus.setImageNote(count === 1 ? t('✓ 图片已插入') : t('✓ 已插入 {n} 张图片', { n: inserted }), { state: 'done', ttl: 2500 });
    compose.focus();
  } catch (error) {
    if (epoch === viewEpoch && selected === id && attempt === imageEpoch) {
      if (error.revoked) handleTerminalError(error);
      else {
        composeStatus.setImageNote(t('⚠ 图片上传失败'), { state: 'error', ttl: 6000 });
        message('image-error', count > 1
          ? t('已插入 {inserted}/{count} 张图片。{error} 请重新选择剩余未上传的图片。', { inserted, count, error: t(error.message) })
          : t(error.message));
        if (!get('image-dialog').open) get('image-dialog').showModal();
      }
    }
  } finally {
    if (composeStatus.imageNote()?.state === 'busy' && attempt === imageEpoch) composeStatus.setImageNote('');
    sendingImage = false;
    get('attach-image').disabled = !terminalReady;
    get('attach-image').removeAttribute('aria-busy');
    get('choose-image').disabled = false;
    get('choose-image').textContent = t('选择图片');
    updateComposerActions();
  }
}
get('attach-image').addEventListener('click', sendImage);
get('expanded-attach').addEventListener('click', sendImage);
get('choose-image').addEventListener('click', sendImage);

void initialize();
