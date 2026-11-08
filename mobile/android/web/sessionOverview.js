// 手机会话纵览：这台电脑上所有项目的手机会话，按项目分组、筛选、搜索，支持多选批量关闭。
// 工作台首页与终端会话抽屉各挂一个实例；只负责渲染与交互，数据由调用方读取后 setList 写入。
import {
  countSessionOverview,
  createdLabel,
  groupSessionOverview,
  idleLabel,
  limitSessionGroups,
  projectSourceLabel,
  prunedSelection,
  sessionName,
  sessionRunning,
} from './protocol.js';
import { icon, rowText, button } from './dom.js';
import { onSessionPrefsChange, runningFirst, runningFirstToggle, runningStatusEnabled } from './sessionPrefs.js';
import { t } from './i18n.js';

/**
 * root：组件容器。limit：首次显示的会话数（首页 8，抽屉不限）。
 * compactBelow：会话总数不超过该值且未搜索 / 筛选时收起搜索框与状态筛选（首页会话少时不占屏）。
 * header：可选的标题行；收起时「运行中优先」与「管理」移到标题右侧，省掉一整行。
 * state：profile()、projects()、history()、current()（终端页当前项目 id，首页为 null）、
 * selected()（当前终端会话 id）、lastSession(projectId)（该项目上次使用的会话）、busy()、visible?(item)。
 * open(session) 接入会话；end(sessions) 关闭一个或多个会话（确认与结果提示由调用方负责），返回 Promise。
 * onChange() 在列表或数量变化后通知调用方（如更新标题数量、显示/隐藏所在区块）。
 */
export function createSessionOverview({ root, limit = Infinity, compactBelow = 0, header = null, state, open, end, onChange = () => {} }) {
  let items = [];
  let address = null;
  let filter = 'all';
  let query = '';
  let expanded = false;
  let selecting = false;
  let selection = new Set();

  root.classList.add('session-overview');
  root.innerHTML = '';
  const tools = document.createElement('div');
  tools.className = 'overview-tools';
  const search = document.createElement('div');
  search.className = 'search-field';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'overview-search';
  input.placeholder = t('搜索会话、项目或设备');
  input.setAttribute('aria-label', t('搜索会话、项目或设备'));
  input.autocomplete = 'off';
  input.enterKeyHint = 'search';
  search.append(icon('search'), input);
  // 搜索行：搜索框、「运行中优先」图标、「管理」多选；会话少时只收起搜索框，图标与「管理」靠右保留。
  const sort = runningFirstToggle('overview-sort');
  const manage = button('text-button overview-manage', () => setSelecting(!selecting));
  const actions = document.createElement('div');
  actions.className = 'overview-actions';
  actions.append(sort.element, manage);
  tools.append(search, actions);

  const filters = document.createElement('div');
  filters.className = 'segmented overview-filter';
  filters.setAttribute('role', 'radiogroup');
  filters.setAttribute('aria-label', t('会话状态'));
  for (const value of ['all', 'live', 'exited']) {
    const option = button('', () => {
      if (filter === value) return;
      filter = value;
      render();
    });
    option.setAttribute('role', 'radio');
    option.dataset.filter = value;
    filters.append(option);
  }

  // 多选工具条：已选数量、全选（当前筛选与搜索结果）、只选已结束、关闭所选。
  const bar = document.createElement('div');
  bar.className = 'overview-select-bar';
  bar.hidden = true;
  const picked = document.createElement('span');
  picked.className = 'overview-picked';
  picked.setAttribute('role', 'status');
  const selectAll = button('text-button overview-select-all', () => {
    const matching = matchingItems().filter(batchable);
    const all = matching.length > 0 && matching.every(item => selection.has(item.id));
    selection = all ? new Set() : new Set(matching.map(item => item.id));
    render();
  });
  const selectEnded = button('text-button overview-select-ended', () => {
    selection = new Set(matchingItems().filter(item => item.exit).map(item => item.id));
    render();
  });
  const endPicked = button('tonal compact danger overview-end', () => {
    const targets = list().filter(item => selection.has(item.id));
    if (!targets.length || state.busy()) return;
    void Promise.resolve(end(targets)).then(() => {
      selection = prunedSelection(selection, list());
      if (!selection.size) setSelecting(false);
      else render();
    });
  });
  bar.append(picked, selectAll, selectEnded, endPicked);

  const groupsNode = document.createElement('div');
  groupsNode.className = 'overview-groups';
  const empty = document.createElement('p');
  empty.className = 'hint overview-empty';
  const more = button('text-button overview-more', () => { expanded = !expanded; render(); });
  const error = document.createElement('p');
  error.className = 'error overview-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(tools, filters, bar, error, groupsNode, empty, more);
  onSessionPrefsChange(() => render());

  input.addEventListener('input', () => { query = input.value; render(); });

  /** 电脑上开的终端不参与批量关闭，避免「全选」误结束电脑上的任务；单个关闭仍可用。 */
  function batchable(item) {
    return item.origin !== 'desktop';
  }

  /** 当前连接的会话（调用方可再排除已在别处关闭的项）。 */
  function list() {
    const profile = state.profile();
    if (!profile || address !== profile.id) return [];
    return state.visible ? items.filter(state.visible) : items;
  }

  function matchingItems() {
    return groupSessionOverview(list(), { projects: state.projects(), filter, query, runningFirst: runningFirst() }).flatMap(group => group.sessions);
  }

  function setSelecting(next) {
    selecting = next;
    if (!selecting) selection = new Set();
    render();
  }

  function render() {
    const all = list();
    const busy = state.busy();
    selection = prunedSelection(selection, all);
    const counts = countSessionOverview(all);
    const grouped = groupSessionOverview(all, {
      projects: state.projects(), current: state.current(), history: state.history(), filter, query, runningFirst: runningFirst(),
    });
    // 搜索、筛选或多选时显示全部结果，避免选中的会话藏在「展开全部」后面。
    const narrowed = !!query.trim() || filter !== 'all' || selecting;
    const { groups, hidden } = expanded || narrowed ? { groups: grouped, hidden: 0 } : limitSessionGroups(grouped, limit);
    root.dataset.selecting = String(selecting);
    // 会话少时不显示搜索与筛选；已在搜索或筛选中则保留，避免控件突然消失。
    const compact = all.length <= compactBelow && !query.trim() && filter === 'all';
    search.hidden = compact;
    const actionsHome = compact && header ? header : tools;
    if (actions.parentNode !== actionsHome) actionsHome.append(actions);
    tools.hidden = compact && !!header;
    filters.hidden = compact;
    sort.relabel();
    // 静态文案也在每次渲染时取当前语言，切换语言后重绘即生效。
    input.placeholder = t('搜索会话、项目或设备');
    input.setAttribute('aria-label', t('搜索会话、项目或设备'));
    filters.setAttribute('aria-label', t('会话状态'));
    manage.textContent = selecting ? t('完成') : t('管理');
    manage.disabled = !all.length && !selecting;
    manage.setAttribute('aria-pressed', String(selecting));
    for (const option of filters.children) {
      option.setAttribute('aria-checked', String(option.dataset.filter === filter));
      option.textContent = { all: t('全部'), live: t('未结束'), exited: t('已结束') }[option.dataset.filter] + ' ' + counts[option.dataset.filter];
    }
    bar.hidden = !selecting;
    const matching = grouped.flatMap(group => group.sessions).filter(batchable);
    picked.textContent = t('已选 {n}', { n: selection.size });
    const allPicked = matching.length > 0 && matching.every(item => selection.has(item.id));
    selectAll.textContent = allPicked ? t('取消全选') : t('全选 {n}', { n: matching.length });
    selectAll.disabled = busy || !matching.length;
    selectEnded.textContent = t('选已结束');
    selectEnded.disabled = busy || !matching.some(item => item.exit);
    endPicked.textContent = t('关闭所选');
    endPicked.disabled = busy || !selection.size;
    empty.hidden = groups.length > 0;
    empty.textContent = all.length ? t('没有符合条件的会话') : t('这台电脑上还没有手机会话');
    more.hidden = !hidden && !(expanded && !narrowed && grouped.reduce((sum, group) => sum + group.sessions.length, 0) > limit);
    more.textContent = hidden ? t('展开全部（还有 {n} 个）', { n: hidden }) : t('收起');
    const existing = new Map([...groupsNode.children].map(node => [node.dataset.project, node]));
    groups.forEach((group, position) => {
      let node = existing.get(group.project.id);
      if (!node) node = createGroup(group.project.id);
      existing.delete(group.project.id);
      renderGroup(node, group, busy);
      if (groupsNode.children[position] !== node) groupsNode.insertBefore(node, groupsNode.children[position] ?? null);
    });
    for (const node of existing.values()) node.remove();
    onChange();
  }

  function createGroup(projectId) {
    const node = document.createElement('section');
    node.className = 'session-group';
    node.dataset.project = projectId;
    const head = document.createElement('div');
    head.className = 'session-group-head';
    const name = document.createElement('strong');
    const source = document.createElement('span');
    source.className = 'session-group-source';
    const count = document.createElement('span');
    count.className = 'session-group-count';
    head.append(name, source, count);
    const rows = document.createElement('div');
    rows.className = 'rows session-group-rows';
    node.append(head, rows);
    return node;
  }

  function renderGroup(node, group, busy) {
    const current = group.project.id === state.current();
    const title = group.project.name ?? group.project.id;
    node.querySelector('strong').textContent = title;
    node.querySelector('.session-group-source').textContent = [projectSourceLabel(group.project), current ? t('当前项目') : '',
      group.missing ? t('电脑端已移除') : ''].filter(Boolean).join(' · ');
    node.querySelector('.session-group-count').textContent = String(group.total ?? group.sessions.length);
    node.setAttribute('aria-label', title);
    const rows = node.querySelector('.session-group-rows');
    const existing = new Map([...rows.children].map(row => [row.dataset.id, row]));
    const last = state.lastSession(group.project.id);
    group.sessions.forEach((session, position) => {
      let row = existing.get(session.id);
      if (!row) row = createRow(session.id);
      existing.delete(session.id);
      renderRow(row, session, { current, last: session.id === last, busy });
      if (rows.children[position] !== row) rows.insertBefore(row, rows.children[position] ?? null);
    });
    for (const row of existing.values()) row.remove();
  }

  function createRow(id) {
    const row = document.createElement('div');
    row.className = 'session-option';
    row.dataset.id = id;
    const latest = () => list().find(item => item.id === id);
    const option = button('row', () => {
      if (state.busy() || !latest()) return;
      if (selecting) {
        if (!batchable(latest())) return;
        if (selection.has(id)) selection.delete(id);
        else selection.add(id);
        render();
      } else void open(latest());
    });
    const check = document.createElement('span');
    check.className = 'session-check';
    check.setAttribute('aria-hidden', 'true');
    check.append(icon('check'));
    const text = rowText('', '');
    const heading = text.querySelector('strong');
    const name = document.createElement('span');
    name.className = 'session-label';
    heading.append(icon('loader-circle', 'session-spinner'), name);
    const idle = document.createElement('small');
    idle.className = 'session-idle';
    text.append(idle);
    option.append(check, text);
    const close = button('icon-button session-close', () => {
      if (!state.busy() && latest()) void end([latest()]);
    });
    close.append(icon('close'));
    row.append(option, close);
    return row;
  }

  function renderRow(row, session, { current, last, busy }) {
    const label = sessionName(session);
    const active = current && session.id === state.selected();
    // 只影响显示；「运行中优先」排序仍按真实状态。
    const running = runningStatusEnabled() && sessionRunning(session);
    const checked = selection.has(session.id);
    row.dataset.current = String(active);
    row.dataset.running = String(running);
    row.dataset.checked = String(checked);
    const option = row.querySelector('.row');
    option.disabled = busy || (selecting && !batchable(session));
    row.dataset.desktop = String(!batchable(session));
    if (selecting) {
      option.setAttribute('aria-pressed', String(checked));
      option.setAttribute('aria-label', t('选择 {name}', { name: label }));
    } else {
      option.removeAttribute('aria-pressed');
      option.setAttribute('aria-label', t('切换到 {name}', { name: label }));
    }
    if (active) option.setAttribute('aria-current', 'true');
    else option.removeAttribute('aria-current');
    const identity = batchable(session) ? t('终端 {n}', { n: session.number ?? 1 }) : t('电脑终端');
    const status = session.exit ? t('已结束')
      : [running ? t('运行中') : '', active ? t('当前会话') : last ? t('上次使用') : ''].filter(Boolean).join(' · ');
    const device = session.ownDevice === false ? t('来自 {device}', { device: session.deviceName || t('其他设备') }) : '';
    row.querySelector('.session-label').textContent = label;
    const inUse = !session.exit && session.inUseHere === false && session.controllerName
      ? t('在 {name} 上使用中', { name: t(session.controllerName) }) : '';
    row.querySelector('small').textContent = [label === identity ? '' : identity, status, inUse, createdLabel(session), device].filter(Boolean).join(' · ');
    const idle = row.querySelector('.session-idle');
    idle.textContent = session.exit ? '' : idleLabel(session);
    idle.hidden = !idle.textContent;
    const close = row.querySelector('.session-close');
    close.setAttribute('aria-label', t(session.exit ? '移除 {name}' : '关闭 {name}', { name: label }));
    close.disabled = busy;
  }

  return {
    render,
    /** 写入某个连接最新的全部会话；换连接时清空搜索以外的临时状态。 */
    setList(next, profileId) {
      if (profileId !== address) {
        selection = new Set();
        selecting = false;
        expanded = false;
      }
      items = Array.isArray(next) ? next : [];
      address = profileId;
      render();
    },
    remove(ids) {
      const gone = new Set(ids);
      items = items.filter(item => !gone.has(item.id));
      for (const id of gone) selection.delete(id);
      render();
    },
    clear() { items = []; address = null; selection = new Set(); selecting = false; render(); },
    list,
    count: () => list().length,
    setError(text) { error.textContent = text ? t(text) : ''; error.hidden = !text; },
    /** 退出多选（如离开页面）；不影响列表。 */
    reset() { if (selecting) setSelecting(false); },
    isSelecting: () => selecting,
  };
}
