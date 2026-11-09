// 手机会话纵览：这台电脑上所有项目的手机会话，按项目分组、筛选、搜索，支持多选批量关闭。
// 工作台首页与终端会话抽屉各挂一个实例；只负责渲染与交互，数据由调用方读取后 setList 写入。
import {
  countSessionOverview,
  groupSessionOverview,
  limitSessionGroups,
  projectSourceLabel,
  prunedSelection,
  sessionIdleInfo,
  sessionName,
  sessionRunning,
  sessionStatusLine,
} from './protocol.js';
import { icon, rowText, button } from './dom.js';
import { attachDragSort, attachLongPress, attachSwipeReveal, closeRevealedRow } from './gestures.js';
import { dragTargetIndex } from './keyLayout.js';
import { onSessionPrefsChange, runningFirst, runningFirstToggle, runningStatusEnabled } from './sessionPrefs.js';
import { t } from './i18n.js';

/**
 * root：组件容器。limit：首次显示的会话数（首页 8，抽屉不限）。
 * compactBelow：会话总数不超过该值且未搜索 / 筛选时收起搜索框与状态筛选（首页会话少时不占屏）；0 表示始终显示（抽屉）。
 * header：可选的标题行；收起时「运行中优先」与「管理」移到标题右侧，省掉一整行。
 * state：profile()、projects()、history()、current()（终端页当前项目 id，首页为 null）、
 * selected()（当前终端会话 id）、lastSession(projectId)（该项目上次使用的会话）、busy()、visible?(item)。
 * open(session) 接入会话；end(sessions) 关闭一个或多个会话（确认与结果提示由调用方负责），返回 Promise。
 * onChange() 在列表或数量变化后通知调用方（如更新标题数量、显示/隐藏所在区块）。
 * groupTools（侧栏）：项目固定顺序与组头操作，含 order()、collapsed(id)、toggle(id)、attention(sessionId)、
 * add(project)、menu(project)、reorder(visibleIds, from, to)、sessionOrder(projectId)、reorderSessions(projectId, visibleIds, from, to)、
 * pins(projectId)、sessionMenu(session)（行内 ⋯ 与长按打开的会话操作）；
 * 首页不传，保持按最近打开排序、组头只显示信息，长按露出关闭。
 */
export function createSessionOverview({ root, limit = Infinity, compactBelow = 0, header = null, state, open, end, onChange = () => {}, groupTools = null }) {
  let items = [];
  let address = null;
  let filter = 'all';
  let query = '';
  let showFilters = false;
  let expanded = false;
  let selecting = false;
  let selection = new Set();
  // 组头按钮点按时取最新的分组数据。
  const renderedGroups = new Map();

  root.classList.add('session-overview');
  root.innerHTML = '';
  const tools = document.createElement('div');
  tools.className = 'overview-tools';
  const search = document.createElement('div');
  search.className = 'search-field';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'overview-search';
  // WebView 聚焦时会强制裁切原生占位文字，这里用空格占位驱动 :placeholder-shown，由提示层显示完整文案。
  input.placeholder = ' ';
  input.setAttribute('aria-label', t('搜索会话、项目或设备'));
  input.autocomplete = 'off';
  input.enterKeyHint = 'search';
  const hint = document.createElement('span');
  hint.className = 'overview-search-hint';
  hint.setAttribute('aria-hidden', 'true');
  const hintText = document.createElement('span');
  hint.append(hintText);
  hintText.textContent = t('搜索会话');
  search.append(icon('search'), input, hint);
  // 搜索行：搜索框、筛选、「运行中优先」图标、「管理」多选；会话少时只收起搜索框与筛选，其余靠右保留。
  const filterToggle = button('icon-button overview-filter-toggle', () => { showFilters = !showFilters; render(); });
  filterToggle.append(icon('filter'));
  const sort = runningFirstToggle('overview-sort');
  const manage = button('text-button overview-manage', () => setSelecting(!selecting));
  const actions = document.createElement('div');
  actions.className = 'overview-actions';
  actions.append(filterToggle, sort.element, manage);
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

  // 长按组头拖动排序；搜索、筛选和多选时项目列表不完整，不允许拖动。
  const draggableGroup = '.session-group[data-draggable="true"]';
  const draggableRow = '.session-option[data-draggable="true"]';
  if (groupTools) attachDragSort(groupsNode, {
    rowSelector: draggableGroup,
    ignoreSelector: '.session-group-rows, .session-group-head .icon-button',
    targetIndex: dragTargetIndex,
    onDrop: (_row, from, to) => {
      groupTools.reorder([...groupsNode.querySelectorAll(draggableGroup)].map(node => node.dataset.project), from, to);
      render();
    },
  });

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
    closeRevealedRow();
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
      order: groupTools?.order() ?? null,
      sessionOrder: groupTools?.sessionOrder ?? null,
      pins: groupTools?.pins ?? null,
    });
    // 搜索、筛选或多选时显示全部结果，避免选中的会话藏在「展开全部」后面。
    const narrowed = !!query.trim() || filter !== 'all' || selecting;
    const { groups, hidden } = expanded || narrowed ? { groups: grouped, hidden: 0 } : limitSessionGroups(grouped, limit);
    root.dataset.selecting = String(selecting);
    // 会话少时不显示搜索与筛选；已在搜索或筛选中则保留，避免控件突然消失。
    const compact = compactBelow > 0 && all.length <= compactBelow && !query.trim() && filter === 'all';
    search.hidden = compact;
    const actionsHome = compact && header ? header : tools;
    if (actions.parentNode !== actionsHome) actionsHome.append(actions);
    tools.hidden = compact && !!header;
    // 正在筛选时保持筛选条可见，否则看不出列表为什么变少。
    filters.hidden = compact || !(showFilters || filter !== 'all');
    filterToggle.hidden = compact;
    filterToggle.setAttribute('aria-label', t('筛选会话'));
    filterToggle.setAttribute('aria-expanded', String(!filters.hidden));
    filterToggle.dataset.active = String(filter !== 'all');
    sort.relabel();
    // 静态文案也在每次渲染时取当前语言，切换语言后重绘即生效。
    hintText.textContent = t('搜索会话');
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
      renderGroup(node, group, busy, narrowed);
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
    const summary = [icon('folder', 'session-group-icon'), name, source, count];
    if (groupTools) {
      // 触屏没有悬停：新建和项目操作常驻，点组头其余区域折叠；没有会话的项目无可折叠内容。
      head.classList.add('session-group-head-tools');
      const toggle = button('session-group-toggle', () => {
        if (!toggle.hasAttribute('aria-expanded')) return;
        groupTools.toggle(projectId);
        render();
      });
      const attention = document.createElement('span');
      attention.className = 'session-attention session-group-attention';
      toggle.append(...summary, attention, icon('chevron-down', 'session-group-chevron'));
      const add = button('icon-button session-group-add', () => groupTools.add(renderedGroups.get(projectId).project));
      add.append(icon('plus'));
      const actions = button('icon-button session-group-more', () => groupTools.menu(renderedGroups.get(projectId).project));
      actions.append(icon('more'));
      head.append(toggle, add, actions);
    } else {
      head.append(...summary);
    }
    const rows = document.createElement('div');
    rows.className = 'rows session-group-rows';
    // 终端只在所属项目内拖动；原地长按打开会话操作，与「本项目」一致。
    if (groupTools) attachDragSort(rows, {
      rowSelector: draggableRow,
      ignoreSelector: '.session-close, .session-more',
      targetIndex: dragTargetIndex,
      onHold: row => {
        const session = list().find(item => item.id === row.dataset.id);
        if (session) groupTools.sessionMenu(session);
      },
      onDrop: (_row, from, to) => {
        groupTools.reorderSessions(projectId, [...rows.querySelectorAll(draggableRow)].map(row => row.dataset.id), from, to);
        render();
      },
    });
    node.append(head, rows);
    return node;
  }

  function renderGroup(node, group, busy, narrowed) {
    const current = group.project.id === state.current();
    const title = group.project.name ?? group.project.id;
    node.dataset.currentProject = String(current);
    node.querySelector('strong').textContent = title;
    // 组头只留连接名，地址在项目页和搜索中可见。
    node.querySelector('.session-group-source').textContent = [projectSourceLabel({ ...group.project, host: '' }), current ? t('当前项目') : '',
      group.missing ? t('电脑端已移除') : ''].filter(Boolean).join(' · ');
    node.querySelector('.session-group-count').textContent = String(group.total ?? group.sessions.length);
    node.setAttribute('aria-label', title);
    const rows = node.querySelector('.session-group-rows');
    if (groupTools) renderGroupTools(node, rows, group, busy, narrowed, title);
    const existing = new Map([...rows.children].map(row => [row.dataset.id, row]));
    const last = state.lastSession(group.project.id);
    const pinnedIds = new Set(groupTools?.pins(group.project.id) ?? []);
    group.sessions.forEach((session, position) => {
      let row = existing.get(session.id);
      if (!row) row = createRow(session.id);
      existing.delete(session.id);
      const pinned = pinnedIds.has(session.id);
      // 置顶的会话固定在最前，不参与拖动。
      renderRow(row, session, { current, last: session.id === last, busy, pinned, draggable: !!groupTools && !narrowed && !runningFirst() && !pinned });
      if (rows.children[position] !== row) rows.insertBefore(row, rows.children[position] ?? null);
    });
    for (const row of existing.values()) row.remove();
  }

  function renderGroupTools(node, rows, group, busy, narrowed, title) {
    const id = group.project.id;
    renderedGroups.set(id, group);
    const collapsible = group.sessions.length > 0 && !narrowed;
    const collapsed = collapsible && groupTools.collapsed(id);
    node.dataset.empty = String(!group.sessions.length);
    node.dataset.draggable = String(!!group.member && !narrowed);
    // 折叠后行内圆点看不到，提到组头。
    node.dataset.attention = String(collapsed && group.sessions.some(session => groupTools.attention(session.id)));
    rows.hidden = collapsed;
    const toggle = node.querySelector('.session-group-toggle');
    if (collapsible) toggle.setAttribute('aria-expanded', String(!collapsed));
    else toggle.removeAttribute('aria-expanded');
    const add = node.querySelector('.session-group-add');
    add.disabled = busy || !!group.missing;
    add.setAttribute('aria-label', t('在 {name} 新建终端', { name: title }));
    const actions = node.querySelector('.session-group-more');
    actions.disabled = busy;
    actions.setAttribute('aria-label', t('{name} 的项目操作', { name: title }));
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
    const attention = document.createElement('span');
    attention.className = 'session-attention';
    attention.setAttribute('aria-hidden', 'true');
    heading.append(icon('loader-circle', 'session-spinner'), attention, icon('pin', 'session-pin'), name);
    const idle = document.createElement('small');
    idle.className = 'session-idle';
    text.append(idle);
    option.append(check, text);
    const close = button('swipe-action session-close', () => {
      if (!state.busy() && latest()) void end([latest()]);
    });
    close.append(icon('close'), document.createElement('span'));
    const face = document.createElement('div');
    face.className = 'session-face';
    face.append(option);
    // 侧栏的行与「本项目」一样有 ⋯，首页只留左滑关闭。
    const menu = () => { if (latest()) groupTools.sessionMenu(latest()); };
    if (groupTools) {
      const more = button('icon-button session-more', menu);
      more.append(icon('more'));
      face.append(more);
    }
    row.append(close, face);
    // 左滑露出关闭；多选时用勾选，不响应手势。
    const swipe = attachSwipeReveal(row, face, { enabled: () => !selecting && !state.busy() });
    attachLongPress(option, groupTools ? menu : swipe.open, { enabled: () => row.dataset.draggable !== 'true' && !selecting });
    return row;
  }

  function renderRow(row, session, { current, last, busy, pinned, draggable }) {
    row.dataset.draggable = String(draggable);
    row.dataset.pinned = String(pinned);
    const label = sessionName(session);
    const active = current && session.id === state.selected();
    // 只影响显示；「运行中优先」排序仍按真实状态。
    const running = runningStatusEnabled() && sessionRunning(session);
    const checked = selection.has(session.id);
    const fresh = !!groupTools?.attention(session.id);
    row.dataset.attention = String(fresh);
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
    row.querySelector('.session-label').textContent = label;
    row.querySelector('small').textContent = sessionStatusLine(session, { running, active, last, pinned, fresh });
    // 快到自动结束时单独一行提醒。
    const idleInfo = sessionIdleInfo(session);
    const idle = row.querySelector('.session-idle');
    idle.textContent = idleInfo.expiring ? idleInfo.text : '';
    idle.hidden = !idle.textContent;
    const close = row.querySelector('.session-close');
    close.setAttribute('aria-label', t(session.exit ? '移除 {name}' : '关闭 {name}', { name: label }));
    close.querySelector('span').textContent = t(session.exit ? '移除' : '关闭');
    close.disabled = busy;
    const more = row.querySelector('.session-more');
    if (more) {
      more.disabled = busy;
      more.setAttribute('aria-label', t('{name} 的更多操作', { name: label }));
    }
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
