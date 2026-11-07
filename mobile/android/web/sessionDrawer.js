// 左侧会话抽屉：按项目列出手机会话、置顶、重命名、结束；打开且在前台时定时刷新元数据。
import {
  idleLabel,
  mergeSessionActivity,
  mergeSessionList,
  mergeSessionName,
  orderSessions,
  parseSessionPins,
  prunedSessionPins,
  projectSourceLabel,
  sessionName,
  sessionRunning,
  toggleSessionPin,
} from './protocol.js';
import { attachLongPress } from './gestures.js';
import { get, message, icon, rowText, button, collapseAndRemove } from './dom.js';
import { t } from './i18n.js';

const REFRESH_INTERVAL = 1500;

/**
 * state：读取 app 状态的 getter（profile、project、sessions、selected、busy、viewEpoch、foreground），
 * setSessions(list) 写回会话列表；selectSession / endSession 由 app 执行。
 */
export function createSessionDrawer({ prefix, remote, state, setSessions, selectSession, endSession }) {
  const drawer = get('session-drawer');
  let drawerEpoch = 0;
  let refreshTimer;
  let refreshing = false;
  let actionSession = null;
  let renamingSession = null;

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
    const busy = state.busy();
    const project = state.project();
    const profile = state.profile();
    const current = sessions.find(item => item.id === selected);
    get('terminal-name').textContent = current ? sessionName(current) : project?.name ?? t('终端');
    get('terminal-host').textContent = project ? project.name + ' · ' + projectSourceLabel({ ...project, host: '' }) : '';
    get('session-context').textContent = project ? profile.name + ' / ' + project.name + ' · ' + projectSourceLabel(project) : '';
    get('session-name-hint').hidden = sessions.every(item => Number.isFinite(item.nameRevision));
    const options = get('session-options');
    // 上一轮还没收起完的行直接移除，不参与本轮排序。
    for (const row of options.querySelectorAll('[data-leaving]')) row.remove();
    const existingRows = new Map([...options.children].map(row => [row.dataset.id, row]));
    const liveIds = new Set(sessions.map(item => item.id));
    const gone = [...existingRows.values()].filter(row => !liveIds.has(row.dataset.id));
    // 同一列表少了几行才收起；切项目或全部结束是整表替换，直接移除。
    const collapse = drawer.open && existingRows.size > gone.length;
    get('session-count').textContent = String(sessions.length);
    get('end-all-sessions').disabled = busy || !sessions.length;
    get('drawer-new-session').disabled = busy;
    const pinned = new Set(pins());
    for (const [position, { session, index }] of orderSessions(sessions, [...pinned]).entries()) {
      const label = sessionName(session, index + 1);
      let row = existingRows.get(session.id);
      if (!row) row = createRow(session);
      existingRows.delete(session.id);
      row.dataset.current = String(session.id === selected);
      row.dataset.pinned = String(pinned.has(session.id));
      const running = sessionRunning(session);
      row.dataset.running = String(running);
      const option = row.querySelector('.row');
      option.disabled = busy;
      option.setAttribute('aria-label', t('切换到 {name}', { name: label }));
      const status = session.exit ? t('已结束') : [running ? t('运行中') : '', session.id === selected ? t('当前会话') : t('可接入')].filter(Boolean).join(' · ');
      const identity = t('终端 {n}', { n: session.number ?? index + 1 });
      row.querySelector('.session-label').textContent = label;
      row.querySelector('small').textContent = [pinned.has(session.id) ? t('已置顶') : '', label === identity ? '' : identity, status]
        .filter(Boolean).join(' · ');
      const idle = row.querySelector('.session-idle');
      idle.textContent = session.exit ? '' : idleLabel(session);
      idle.hidden = !idle.textContent;
      row.querySelector('.session-more').setAttribute('aria-label', t('{name} 的更多操作', { name: label }));
      row.querySelector('.session-more').disabled = busy;
      const close = row.querySelector('.session-close');
      close.setAttribute('aria-label', t(session.exit ? '移除 {name}' : '关闭 {name}', { name: label }));
      close.disabled = busy;
      if (session.id === selected) option.setAttribute('aria-current', 'true');
      else option.removeAttribute('aria-current');
      // 只按留下的行定位，要收起的行留在原地。
      const next = [...options.children].filter(child => !gone.includes(child))[position];
      if (next !== row) options.insertBefore(row, next ?? null);
    }
    for (const row of gone) {
      if (collapse) collapseAndRemove(row);
      else row.remove();
    }
  }

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
    heading.append(icon('loader-circle', 'session-spinner'), icon('pin', 'session-pin'), name);
    // 空闲 24 小时无输入也无输出时电脑端自动结束会话。
    const idle = document.createElement('small');
    idle.className = 'session-idle';
    text.append(idle);
    option.append(text);
    // 长按整行或点 ⋯ 打开会话操作（置顶、重命名、结束）。
    attachLongPress(option, () => { if (latest()) openActions(latest()); });
    const more = button('icon-button session-more', () => { if (latest()) openActions(latest()); });
    more.append(icon('more'));
    const close = button('icon-button session-close', () => { void endSession(session.id); });
    close.append(icon('close'));
    row.append(option, more, close);
    return row;
  }

  async function open() {
    drawerEpoch += 1;
    clearTimeout(refreshTimer);
    render();
    if (!drawer.open) drawer.showModal();
    get('show-sessions').setAttribute('aria-expanded', 'true');
    await refresh();
  }

  async function refresh() {
    if (state.busy() || refreshing || !drawer.open || document.hidden || !state.foreground()) return;
    refreshing = true;
    const epoch = state.viewEpoch();
    const currentDrawer = drawerEpoch;
    try {
      const list = await remote('sessions', { project: state.project().id });
      if (epoch !== state.viewEpoch() || currentDrawer !== drawerEpoch || !drawer.open) return;
      setSessions(mergeSessionList(list, state.sessions()));
      prunePins(state.sessions());
      message('session-error', '');
      render();
    } catch (error) {
      if (epoch === state.viewEpoch() && currentDrawer === drawerEpoch && drawer.open) message('session-error', error.message);
    } finally {
      refreshing = false;
      if (drawer.open && !document.hidden && state.foreground()) refreshTimer = setTimeout(refresh, REFRESH_INTERVAL);
    }
  }

  /** 批量操作期间暂停刷新，丢弃在途的旧列表。 */
  function pause() {
    drawerEpoch += 1;
    clearTimeout(refreshTimer);
  }

  function scheduleRefresh() {
    if (!drawer.open) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, REFRESH_INTERVAL);
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
    get('session-actions-context').textContent = state.profile().name + ' / ' + state.project().name;
    get('session-action-pin').textContent = pinned ? t('取消置顶') : t('置顶');
    get('session-action-rename').disabled = !Number.isFinite(session.nameRevision);
    get('session-action-rename').textContent = Number.isFinite(session.nameRevision) ? t('重命名') : t('重命名（需更新电脑端）');
    get('session-action-end').textContent = session.exit ? t('移除已结束会话') : session.id === state.selected() ? t('结束当前会话') : t('结束会话');
    get('session-actions-dialog').showModal();
  }

  /** 操作菜单打开期间会话可能已被移除或切换了连接，这里取回仍然有效的会话。 */
  function takeActionSession() {
    const target = actionSession;
    get('session-actions-dialog').close();
    if (!target || target.epoch !== state.viewEpoch() || state.profile()?.id !== target.address) return null;
    return state.sessions().find(item => item.id === target.id) ?? null;
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
    drawerEpoch += 1;
    clearTimeout(refreshTimer);
    get('show-sessions').setAttribute('aria-expanded', 'false');
  });
  drawer.addEventListener('toggle', () => get('show-sessions').setAttribute('aria-expanded', String(drawer.open)));
  document.addEventListener('visibilitychange', () => {
    clearTimeout(refreshTimer);
    if (!document.hidden) void refresh();
  });

  return { render, open, refresh, pause, scheduleRefresh, wake, sleep, pins, savePins, prunePins };
}
