// 左侧会话抽屉：按项目列出手机会话、置顶、重命名、结束；打开且在前台时定时刷新元数据。
// 「全部」范围显示这台电脑上所有项目的手机会话纵览（按项目分组、筛选、搜索）。
import {
  createdLabel,
  joinProjectIds,
  mergeSessionActivity,
  mergeSessionList,
  mergeSessionName,
  orderSessions,
  parseIdList,
  parseSessionPins,
  phoneSessionProjectIds,
  prunedSessionPins,
  projectSessionsFromOverview,
  projectSourceLabel,
  reorderSessionIds,
  reorderVisibleProjects,
  sessionIdleInfo,
  sessionName,
  sessionRunning,
  toggleSessionPin,
  updateSessionAttention,
} from './protocol.js';
import { attachDragSort, attachLongPress, attachSwipeReveal, closeRevealedRow } from './gestures.js';
import { dragTargetIndex } from './keyLayout.js';
import { createSessionOverview } from './sessionOverview.js';
import { get, message, icon, rowText, button, collapseAndRemove } from './dom.js';
import { t } from './i18n.js';
import { onSessionPrefsChange, runningFirst, runningFirstToggle, runningStatusEnabled } from './sessionPrefs.js';

const REFRESH_INTERVAL = 1500;
// 平板常驻时整段终端时间都在刷新，放慢节奏减少电脑端请求。
const DOCKED_REFRESH_INTERVAL = 3000;

/**
 * state：读取 app 状态的 getter（profile、project、sessions、selected、busy、locked、viewEpoch、foreground、
 * projects、history、lastSession、allSupported），busy 拦截操作；locked 决定按钮是否显示为禁用，关闭单个会话时为假，列表不变暗。
 * allSupported() 返回电脑端是否支持一次列出全部会话（Promise<boolean>）。
 * setSessions(list) 写回会话列表；selectSession / endSession 由 app 执行；
 * openOverviewSession / endOverviewSessions 处理纵览中（可能属于其他项目）的会话，后者接收会话数组并负责确认。
 * addProjectSession / switchProject / removeProject 响应「全部」范围项目组头上的新建、切换和移除。
 */
export function createSessionDrawer({ prefix, remote, state, setSessions, selectSession, endSession, openOverviewSession, endOverviewSessions, addProjectSession, switchProject, removeProject }) {
  const drawer = get('session-drawer');
  let drawerEpoch = 0;
  let refreshTimer;
  let refreshing = false;
  let actionSession = null;
  let renamingSession = null;
  let docked = false;
  const scopeKey = prefix + 'session-scope';
  let scope = localStorage.getItem(scopeKey) === 'all' ? 'all' : 'project';
  // null：尚未确认电脑端是否支持；切换连接后重新确认。
  let allAvailable = null;
  let availabilityAddress = null;
  let actionProject = null;
  const tracker = { busy: new Set(), attention: new Set() };

  // 「本项目」列表的「运行中优先」，与纵览中的按钮同步。
  // 与「新建终端」同一行，放在右侧。
  const projectSort = runningFirstToggle('drawer-sort');
  const projectTools = document.createElement('div');
  projectTools.className = 'drawer-project-tools';
  const newSession = get('drawer-new-session');
  newSession.replaceWith(projectTools);
  projectTools.append(newSession, projectSort.element);
  onSessionPrefsChange(() => { if (drawer.open || docked) render(); });

  function allMode() { return scope === 'all' && allAvailable === true && availabilityAddress === state.profile()?.id; }

  function readProjectIds(scope) {
    const profile = state.profile();
    return profile ? parseIdList(localStorage.getItem(prefix + scope + profile.id)) : [];
  }

  function writeProjectIds(scope, list) {
    const profile = state.profile();
    if (!profile) return;
    try {
      if (list.length) localStorage.setItem(prefix + scope + profile.id, JSON.stringify(list));
      else localStorage.removeItem(prefix + scope + profile.id);
    } catch { /* 只是显示偏好，保存失败不影响终端。 */ }
  }

  const sidebarProjects = () => readProjectIds('sidebar-projects:');
  const collapsedProjects = () => readProjectIds('session-groups-collapsed:');

  // 终端手动顺序按连接 + 项目保存，「本项目」与「全部」共用，不改变电脑端终端顺序。
  function sessionOrderKey(projectId) {
    return prefix + 'session-order:' + state.profile().id + ':' + projectId;
  }

  function sessionOrder(projectId) {
    return state.profile() && projectId ? parseIdList(localStorage.getItem(sessionOrderKey(projectId))) : [];
  }

  function reorderSessions(projectId, visible, from, to) {
    try {
      localStorage.setItem(sessionOrderKey(projectId), JSON.stringify(reorderSessionIds(sessionOrder(projectId), visible, from, to)));
    } catch { /* 只是显示偏好，保存失败不影响终端。 */ }
  }

  function joinProjects(ids) {
    const current = sidebarProjects();
    const next = joinProjectIds(current, ids);
    if (next.length !== current.length) writeProjectIds('sidebar-projects:', next);
  }

  /** 打开项目：加入侧栏；折叠着就展开，否则当前会话藏在组里看不到。 */
  function enterProject(id) {
    joinProjects([id]);
    const collapsed = collapsedProjects();
    if (collapsed.includes(id)) writeProjectIds('session-groups-collapsed:', collapsed.filter(item => item !== id));
  }

  function forgetProject(id) {
    writeProjectIds('sidebar-projects:', sidebarProjects().filter(item => item !== id));
    writeProjectIds('session-groups-collapsed:', collapsedProjects().filter(item => item !== id));
    try { localStorage.removeItem(sessionOrderKey(id)); } catch { /* 只是显示偏好。 */ }
  }

  // 「全部」范围的纵览。
  const overview = createSessionOverview({
    root: get('session-overview'),
    state: {
      profile: state.profile,
      projects: state.projects,
      history: state.history,
      current: () => state.project()?.id ?? null,
      selected: state.selected,
      lastSession: state.lastSession,
      busy: state.locked,
    },
    groupTools: {
      order: sidebarProjects,
      collapsed: id => collapsedProjects().includes(id),
      toggle: id => {
        const collapsed = collapsedProjects();
        writeProjectIds('session-groups-collapsed:', collapsed.includes(id) ? collapsed.filter(item => item !== id) : [...collapsed, id]);
      },
      attention: id => tracker.attention.has(id),
      add: project => addProjectSession(project),
      menu: project => openProjectActions(project),
      reorder: (visible, from, to) => writeProjectIds('sidebar-projects:', reorderVisibleProjects(sidebarProjects(), visible, from, to)),
      sessionOrder,
      reorderSessions,
    },
    open: session => openOverviewSession(session),
    end: sessions => endOverviewSessions(sessions),
    onChange: () => {
      if (!allMode()) return;
      const list = overview.list();
      get('session-count').textContent = String(list.length);
      const profile = state.profile();
      get('session-context').textContent = profile
        ? profile.name + ' · ' + t('{n} 个项目', { n: new Set(list.map(item => item.project?.id)).size }) : '';
    },
  });

  function pinsKey(projectId) {
    return prefix + 'session-pins:' + state.profile().id + ':' + projectId;
  }

  function pins() {
    const profile = state.profile();
    const project = state.project();
    return profile && project ? parseSessionPins(localStorage.getItem(pinsKey(project.id))) : [];
  }

  function savePins(list) {
    const project = state.project();
    if (!state.profile() || !project) return;
    try {
      if (list.length) localStorage.setItem(pinsKey(project.id), JSON.stringify(list));
      else localStorage.removeItem(pinsKey(project.id));
    } catch { /* 置顶只是显示偏好，保存失败不影响终端与草稿。 */ }
  }

  /** 拿到完整会话列表后清理已不存在会话的置顶记录。 */
  function prunePins(list) {
    const current = pins();
    const next = prunedSessionPins(current, list);
    if (next.length !== current.length) savePins(next);
  }

  function render() {
    const sessions = state.sessions();
    const selected = state.selected();
    tracker.attention.delete(selected);
    const busy = state.locked();
    const project = state.project();
    const profile = state.profile();
    const current = sessions.find(item => item.id === selected);
    get('terminal-name').textContent = current ? sessionName(current) : project?.name ?? t('终端');
    get('terminal-host').textContent = project ? project.name + ' · ' + projectSourceLabel({ ...project, host: '' }) : '';
    get('session-context').textContent = project ? profile.name + ' / ' + project.name + ' · ' + projectSourceLabel(project) : '';
    get('session-name-hint').hidden = sessions.every(item => Number.isFinite(item.nameRevision));
    const options = get('session-options');
    // 正在收起的行不参与本轮排序，让动画播完；否则下一次渲染会把它直接切掉。
    const staying = child => !child.dataset.leaving;
    const existingRows = new Map([...options.children].filter(staying).map(row => [row.dataset.id, row]));
    const liveIds = new Set(sessions.map(item => item.id));
    const gone = [...existingRows.values()].filter(row => !liveIds.has(row.dataset.id));
    // 同一列表少了几行才收起；切项目或全部结束是整表替换，直接移除。
    const collapse = drawer.open && existingRows.size > gone.length;
    get('session-count').textContent = String(sessions.length);
    get('end-all-sessions').disabled = busy || !sessions.length;
    get('drawer-new-session').disabled = busy;
    const pinned = new Set(pins());
    for (const [position, { session, index }] of orderSessions(sessions, [...pinned], { runningFirst: runningFirst(), order: sessionOrder(project?.id) }).entries()) {
      const label = sessionName(session, index + 1);
      let row = existingRows.get(session.id);
      if (!row) row = createRow(session);
      existingRows.delete(session.id);
      row.dataset.current = String(session.id === selected);
      row.dataset.pinned = String(pinned.has(session.id));
      // 置顶的会话固定在最前；「运行中优先」是临时排序，都不参与拖动。
      row.dataset.draggable = String(!busy && !pinned.has(session.id) && !runningFirst());
      // 只影响显示；「运行中优先」排序仍按真实状态。
      const running = runningStatusEnabled() && sessionRunning(session);
      row.dataset.running = String(running);
      const fresh = tracker.attention.has(session.id);
      row.dataset.attention = String(fresh);
      const option = row.querySelector('.row');
      option.disabled = busy;
      option.setAttribute('aria-label', t('切换到 {name}', { name: label }));
      const status = session.exit ? t('已结束') : [running ? t('运行中') : '', session.id === selected ? t('当前会话') : ''].filter(Boolean).join(' · ');
      const identity = t('终端 {n}', { n: session.number ?? index + 1 });
      row.querySelector('.session-label').textContent = label;
      // 空闲时长并入一行；快到自动结束时才单独提醒。
      const idleInfo = sessionIdleInfo(session);
      row.querySelector('small').textContent = [pinned.has(session.id) ? t('已置顶') : '', label === identity ? '' : identity, fresh ? t('有新结果') : '', status, idleInfo.expiring ? '' : idleInfo.text]
        .filter(Boolean).join(' · ');
      const idle = row.querySelector('.session-idle');
      idle.textContent = idleInfo.expiring ? idleInfo.text : '';
      idle.hidden = !idle.textContent;
      row.querySelector('.session-more').setAttribute('aria-label', t('{name} 的更多操作', { name: label }));
      row.querySelector('.session-more').disabled = busy;
      const close = row.querySelector('.session-close');
      close.setAttribute('aria-label', t(session.exit ? '移除 {name}' : '关闭 {name}', { name: label }));
      close.querySelector('span').textContent = t(session.exit ? '移除' : '关闭');
      close.disabled = busy;
      if (session.id === selected) option.setAttribute('aria-current', 'true');
      else option.removeAttribute('aria-current');
      // 只按留下的行定位，要收起的行留在原地。
      const next = [...options.children].filter(child => staying(child) && !gone.includes(child))[position];
      if (next !== row) options.insertBefore(row, next ?? null);
    }
    for (const row of gone) {
      if (collapse) collapseAndRemove(row);
      else row.remove();
    }
    renderScope();
  }

  function renderScope() {
    const all = allMode();
    for (const item of get('session-scope').querySelectorAll('[data-scope]')) {
      item.setAttribute('aria-checked', String(item.dataset.scope === (all ? 'all' : 'project')));
      if (item.dataset.scope === 'all') item.disabled = allAvailable === false;
    }
    get('session-scope-hint').hidden = allAvailable !== false;
    get('session-options').hidden = all;
    projectTools.hidden = all;
    projectSort.relabel();
    get('end-all-sessions').hidden = all;
    get('session-overview').hidden = !all;
    if (all) overview.render();
    else overview.reset();
  }

  /** 进入「全部」前确认电脑端支持；旧电脑端只保留本项目范围。 */
  async function checkAvailability() {
    const address = state.profile()?.id;
    if (!address) return;
    if (availabilityAddress === address && allAvailable !== null) return;
    availabilityAddress = address;
    allAvailable = null;
    let supported;
    try { supported = await state.allSupported(); } catch { supported = false; }
    if (state.profile()?.id === address) allAvailable = supported;
  }

  function setScope(next) {
    if (next === 'all' && !allAvailable) return;
    if (next === scope) return;
    closeRevealedRow();
    scope = next;
    try { localStorage.setItem(scopeKey, scope); } catch { /* 范围只是显示偏好。 */ }
    drawerEpoch += 1;
    clearTimeout(refreshTimer);
    message('session-error', '');
    overview.setError('');
    render();
    void refresh();
  }

  // 长按后拖动排序，原地松手打开操作菜单。
  const draggableRow = '.session-option[data-draggable="true"]';
  attachDragSort(get('session-options'), {
    rowSelector: draggableRow,
    ignoreSelector: '.session-close, .session-more',
    targetIndex: dragTargetIndex,
    onHold: row => {
      const session = state.sessions().find(item => item.id === row.dataset.id);
      if (session) openActions(session);
    },
    onDrop: (_row, from, to) => {
      const visible = [...get('session-options').querySelectorAll(draggableRow)].map(row => row.dataset.id);
      reorderSessions(state.project().id, visible, from, to);
      render();
    },
  });

  get('session-scope').addEventListener('click', event => {
    const target = event.target.closest?.('[data-scope]');
    if (target && !target.disabled) setScope(target.dataset.scope);
  });
  function createRow(session) {
    const row = document.createElement('div');
    row.className = 'session-option';
    row.dataset.id = session.id;
    const latest = () => state.sessions().find(item => item.id === session.id);
    const option = button('row', () => {
      if (!state.busy() && latest()) selectSession(latest());
    });
    const text = rowText('', '');
    const heading = text.querySelector('strong');
    const name = document.createElement('span');
    name.className = 'session-label';
    const attention = document.createElement('span');
    attention.className = 'session-attention';
    attention.setAttribute('aria-hidden', 'true');
    heading.append(icon('loader-circle', 'session-spinner'), attention, icon('pin', 'session-pin'), name);
    // 空闲 24 小时无输入也无输出时电脑端自动结束会话。
    const idle = document.createElement('small');
    idle.className = 'session-idle';
    text.append(idle);
    option.append(text);
    // 长按整行或点 ⋯ 打开会话操作（置顶、重命名、结束）。
    attachLongPress(option, () => { if (latest()) openActions(latest()); }, { enabled: () => row.dataset.draggable !== 'true' });
    const more = button('icon-button session-more', () => { if (latest()) openActions(latest()); });
    more.append(icon('more'));
    const close = button('swipe-action session-close', () => { void endSession(session.id); });
    close.append(icon('close'), document.createElement('span'));
    const face = document.createElement('div');
    face.className = 'session-face';
    face.append(option, more);
    row.append(close, face);
    attachSwipeReveal(row, face, { enabled: () => !state.busy() });
    return row;
  }

  async function open() {
    drawerEpoch += 1;
    clearTimeout(refreshTimer);
    render();
    // 必须同步打开：常驻切换时 close 事件异步派发，靠此时侧栏已重新打开来保留刷新。
    if (!drawer.open) {
      if (docked) drawer.show();
      else drawer.showModal();
    }
    get('show-sessions').setAttribute('aria-expanded', 'true');
    // 能力按连接缓存，只有首次打开需要等待；确认后再按「全部」范围重绘。
    const currentDrawer = drawerEpoch;
    await checkAvailability();
    if (currentDrawer !== drawerEpoch || !drawer.open) return;
    render();
    await refresh();
    // 分组不再把当前项目置顶，打开时滚到当前会话。
    if (currentDrawer === drawerEpoch && drawer.open) drawer.querySelector('.row[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  async function refresh() {
    if (refreshing || !drawer.open || document.hidden || !state.foreground()) return;
    // 忙碌时稍后再试：常驻侧栏在终端启动期间就已打开，不能就此停止刷新。
    if (state.busy()) { scheduleRefresh(); return; }
    refreshing = true;
    const epoch = state.viewEpoch();
    const currentDrawer = drawerEpoch;
    try {
      const all = allMode();
      const address = state.profile().id;
      const projectId = state.project().id;
      // 全部范围一次取回所有项目的会话，当前项目的列表从中截取，不再单独请求。
      const response = await remote('sessions', all ? { desktop: true } : { project: projectId });
      if (epoch !== state.viewEpoch() || currentDrawer !== drawerEpoch || !drawer.open) return;
      const list = all ? projectSessionsFromOverview(response, projectId) : response;
      setSessions(mergeSessionList(list, state.sessions()));
      prunePins(state.sessions());
      message('session-error', '');
      updateSessionAttention(tracker, all ? response : list, state.selected());
      if (all) {
        joinProjects(phoneSessionProjectIds(response));
        overview.setList(response, address);
      }
      render();
    } catch (error) {
      if (epoch === state.viewEpoch() && currentDrawer === drawerEpoch && drawer.open) message('session-error', error.message);
    } finally {
      refreshing = false;
      if (drawer.open && !document.hidden && state.foreground()) refreshTimer = setTimeout(refresh, interval());
    }
  }

  /** 批量操作期间暂停刷新，丢弃在途的旧列表。 */
  function pause() {
    drawerEpoch += 1;
    clearTimeout(refreshTimer);
  }

  function interval() { return docked ? DOCKED_REFRESH_INTERVAL : REFRESH_INTERVAL; }

  function scheduleRefresh() {
    if (!drawer.open) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, interval());
  }

  /**
   * 平板宽屏常驻：以非模态方式贴在终端左侧，不挡输入；切换会话、打开设置等不再收起。
   * 模态与非模态不能原地切换，变化时先关再按新方式打开。
   */
  function dock(enabled) {
    if (enabled === docked) return;
    docked = enabled;
    drawer.dataset.docked = String(enabled);
    document.documentElement.dataset.sessionsDocked = String(enabled);
    if (drawer.open) drawer.close();
    if (enabled) void open();
  }

  /** 收起侧栏；常驻时保持显示。 */
  function close() {
    if (!docked) drawer.close();
  }

  /** 应用回到前台或页面重新可见时立即刷新；进入后台时停止计时。 */
  function wake() {
    clearTimeout(refreshTimer);
    void refresh();
  }

  function sleep() {
    clearTimeout(refreshTimer);
  }

  function openActions(session) {
    if (state.busy()) return;
    const sessions = state.sessions();
    actionSession = { id: session.id, address: state.profile().id, epoch: state.viewEpoch() };
    const index = sessions.indexOf(session);
    const pinned = pins().includes(session.id);
    get('session-actions-title').textContent = sessionName(session, index + 1);
    get('session-actions-context').textContent = [state.profile().name + ' / ' + state.project().name, createdLabel(session)].filter(Boolean).join(' · ');
    get('session-action-pin').querySelector('span').textContent = pinned ? t('取消置顶') : t('置顶');
    get('session-action-rename').disabled = !Number.isFinite(session.nameRevision);
    get('session-action-rename').querySelector('span').textContent = Number.isFinite(session.nameRevision) ? t('重命名') : t('重命名（需更新电脑端）');
    get('session-action-end').querySelector('span').textContent = session.exit ? t('移除已结束会话') : session.id === state.selected() ? t('结束当前会话') : t('结束会话');
    get('session-actions-dialog').showModal();
  }

  /** 操作菜单打开期间会话可能已被移除或切换了连接，这里取回仍然有效的会话。 */
  function takeActionSession() {
    const target = actionSession;
    get('session-actions-dialog').close();
    if (!target || target.epoch !== state.viewEpoch() || state.profile()?.id !== target.address) return null;
    return state.sessions().find(item => item.id === target.id) ?? null;
  }

  function openProjectActions(project) {
    if (state.busy()) return;
    actionProject = project;
    get('project-actions-title').textContent = project.name ?? project.id;
    get('project-actions-context').textContent = projectSourceLabel({ ...project, host: '' });
    // 当前项目无需切换；电脑端已移除的项目打不开，只能移除。
    get('project-action-switch').hidden = project.id === state.project()?.id || !state.projects().some(item => item.id === project.id);
    get('project-actions-dialog').showModal();
  }

  function takeActionProject() {
    const target = actionProject;
    get('project-actions-dialog').close();
    return state.busy() ? null : target;
  }

  function openRename(session) {
    if (state.busy()) return;
    renamingSession = { id: session.id, address: state.profile().id, epoch: state.viewEpoch() };
    get('save-session-name').disabled = false;
    get('session-name-input').value = session.customName ?? sessionName(session);
    message('rename-session-error', '');
    get('rename-session-dialog').showModal();
    get('session-name-input').select();
  }

  get('session-action-pin').addEventListener('click', () => {
    const session = takeActionSession();
    if (!session) return;
    savePins(toggleSessionPin(pins(), session.id));
    render();
  });
  get('session-action-rename').addEventListener('click', () => {
    const session = takeActionSession();
    if (session) openRename(session);
  });
  get('session-action-end').addEventListener('click', () => {
    const session = takeActionSession();
    if (session) void endSession(session.id);
  });
  get('session-actions-dialog').addEventListener('close', () => { actionSession = null; });
  get('project-action-switch').addEventListener('click', () => {
    const project = takeActionProject();
    if (project) switchProject(project);
  });
  get('project-action-remove').addEventListener('click', () => {
    const project = takeActionProject();
    if (project) void removeProject(project);
  });
  get('project-actions-dialog').addEventListener('close', () => { actionProject = null; });

  get('rename-session-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!renamingSession || get('save-session-name').disabled) return;
    const target = renamingSession;
    get('save-session-name').disabled = true;
    try {
      const result = await remote('rename_session', { id: target.id, name: get('session-name-input').value.trim() }, target.address);
      if (target.epoch !== state.viewEpoch() || state.profile().id !== target.address) return;
      const session = state.sessions().find(item => item.id === target.id);
      if (session) {
        mergeSessionName(session, result);
        mergeSessionActivity(session, result);
      }
      render();
      if (renamingSession === target) get('rename-session-dialog').close();
    } catch (error) {
      if (target.epoch === state.viewEpoch() && renamingSession === target) message('rename-session-error', error.message);
    } finally {
      if (renamingSession === target) get('save-session-name').disabled = false;
    }
  });
  get('rename-session-dialog').addEventListener('close', () => { renamingSession = null; });

  drawer.addEventListener('close', () => {
    // close 事件异步派发：常驻切换时侧栏可能已重新打开，此时不能停掉新一轮刷新。
    if (drawer.open) return;
    drawerEpoch += 1;
    clearTimeout(refreshTimer);
    get('show-sessions').setAttribute('aria-expanded', 'false');
  });
  drawer.addEventListener('toggle', () => get('show-sessions').setAttribute('aria-expanded', String(drawer.open)));
  document.addEventListener('visibilitychange', () => {
    clearTimeout(refreshTimer);
    if (!document.hidden) void refresh();
  });

  return {
    render, open, close, dock, isDocked: () => docked, allMode, refresh, pause, scheduleRefresh, wake, sleep, pins, savePins, prunePins,
    enterProject, forgetProject, sidebarProjects,
    overview,
  };
}
