// 工作台三页的渲染：连接列表、首页（当前电脑与最近项目）、项目列表。只读取状态，不发请求。
import { groupProjectsByHost, matchesProject, projectLocation, projectSourceLabel, recentProjects, sessionIdleInfo, sessionName, sessionRunning } from './protocol.js';
import { get, icon, rowText, tile, button, avatar } from './dom.js';
import { attachLongPress, attachSwipeReveal } from './gestures.js';
import { dateLocale, t } from './i18n.js';
import { runningStatusEnabled } from './sessionPrefs.js';

const COLLAPSED_GROUPS_KEY = 'qingcode:mobile:project-groups-collapsed';

function loadCollapsedGroups() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY));
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

/**
 * state：profile、profiles、projects、loaded 的 getter 与 hostState(item)；resumeSession() 为「继续终端」对应的会话，
 * sessionCount(projectId) 为该项目未结束的会话数，latency() 为当前电脑的延迟文字；
 * lastProject() / projectHistory() 读手机记录；activate / openPair / openHost / openProject / copyProjectPath 为点击动作。
 */
export function createDashboardView({ state, lastProject, projectHistory, syncLatency, activate, openPair, openHost, openProject, copyProjectPath }) {
  const collapsedGroups = loadCollapsedGroups();

  function renderConnections() {
    const profile = state.profile();
    const list = get('connection-list');
    list.replaceChildren();
    get('connection-empty').hidden = state.profiles().length > 0;
    for (const item of [...state.profiles()].sort((a, b) => a.name.localeCompare(b.name, dateLocale()) || a.id.localeCompare(b.id))) {
      const current = item.id === profile?.id;
      const hostState = state.hostState(item);
      const labels = { saved: t('已配对'), checking: t('连接中…'), online: t('已连接'), offline: t('连接失败'), expired: t('需要重新配对') };
      const card = document.createElement('div');
      card.className = 'connection-card';
      card.dataset.current = String(current);
      card.dataset.state = hostState === 'expired' ? 'offline' : hostState;
      const select = button('connection-main', () => {
        if (hostState === 'expired') openPair(item);
        else void activate(item, current ? 'connection' : 'home');
      });
      const detail = button('icon-button', () => openHost(item));
      detail.setAttribute('aria-label', t('管理连接 {name}', { name: item.name }));
      detail.append(icon('more'));
      const dot = document.createElement('span');
      dot.className = 'dot';
      const text = rowText(item.name, item.id);
      const status = document.createElement('small');
      status.className = 'connection-state';
      status.append(dot, labels[hostState] + (current ? t(' · 当前电脑') : ''));
      text.append(status);
      select.append(avatar(item.name), text);
      card.append(select, detail);
      if (current && hostState === 'online') {
        const footer = document.createElement('div');
        footer.className = 'connection-footer';
        const stats = document.createElement('span');
        stats.id = 'current-connection-stats';
        const repair = button('text-button', () => openPair(item));
        repair.textContent = t('重新配对');
        footer.append(stats, repair);
        card.append(footer);
      }
      list.append(card);
    }
    get('active-host-name').textContent = profile?.name ?? t('未连接');
    const hostState = state.hostState(profile);
    get('active-host').dataset.state = hostState === 'expired' ? 'offline' : hostState;
    get('active-host').setAttribute('aria-label', profile ? t('切换连接，当前为 {name}', { name: profile.name }) : t('管理连接'));
    syncLatency();
  }

  function renderHome() {
    const profile = state.profile();
    const profiles = state.profiles();
    const projects = state.projects();
    const recent = lastProject();
    const hostState = state.hostState(profile);
    const canResume = !!recent && hostState === 'online';
    get('resume').hidden = !canResume;
    get('browse-projects').hidden = !canResume;
    get('home-empty').hidden = canResume;
    get('home-guide').hidden = profiles.length > 0;
    // 在线状态已由顶栏电脑徽章表达，这里只说明离线、过期等需要处理的情况。
    get('home-context').hidden = !profile || hostState === 'online';
    get('home-context').dataset.state = hostState === 'expired' ? 'offline' : hostState;
    get('home-context-name').textContent = profile?.name ?? '';
    get('home-context-state').textContent = {
      online: t('{n} 个已信任项目 · 可以打开终端', { n: projects.length }),
      checking: t('正在读取项目…'), offline: t('电脑暂时不可达'), expired: t('配对已失效'), saved: t('等待连接'),
    }[hostState];
    get('home-reconnect').hidden = hostState !== 'offline';
    if (canResume) renderResume();
    const recentList = recentProjects(projects, projectHistory());
    get('home-projects').hidden = hostState !== 'online' || !projects.length;
    get('home-project-list').replaceChildren(...recentList.map(projectRow));
    get('home-recent-empty').hidden = recentList.length > 0;
    const homeStates = {
      checking: [t('正在连接电脑'), t('正在读取已信任的项目。'), t('查看连接')],
      offline: [t('电脑暂时不可达'), t('检查手机和电脑的网络后重试。'), t('重新连接')],
      expired: [t('配对已失效'), t('请在电脑端重新启用 Android 移动连接。'), t('重新配对')],
      online: [t('打开终端'), t('选择已信任的项目，接回已有会话或启动 Shell。'), t('选择项目')],
      saved: profiles.length
        ? [t('选择一台电脑'), t('从已配对的电脑进入终端。'), t('查看连接')]
        : [t('连接一台 QingCode'), t('配对电脑后，就能在这里打开远程终端。'), t('添加连接')],
    };
    const [title, description, action] = homeStates[hostState];
    get('home-empty-title').textContent = title;
    get('home-empty-text').textContent = description;
    get('home-action').textContent = action;
  }

  /** 优先显示上次接入的会话，让用户知道会回到哪里；没有会话记录时回退到项目。 */
  function renderResume() {
    const recent = lastProject();
    const profile = state.profile();
    if (!recent || !profile) return;
    const session = state.resumeSession();
    get('resume-name').textContent = session ? sessionName(session) : recent.name;
    get('resume-host').textContent = session
      ? [recent.name, runningStatusEnabled() && sessionRunning(session) ? t('运行中') : sessionIdleInfo(session).text].filter(Boolean).join(' · ')
      : profile.name + ' / ' + projectSourceLabel(recent);
  }

  function renderConnectionStats() {
    const stats = get('current-connection-stats');
    if (!stats) return;
    const sessions = state.projects().reduce((sum, item) => sum + state.sessionCount(item.id), 0);
    stats.textContent = [t('电脑 {value}', { value: state.latency() }), t('{n} 个项目', { n: state.projects().length }), t('{n} 个会话', { n: sessions })].join(' · ');
  }

  /** grouped：所在主机已由分组标题说明，来源只留给读屏。 */
  function projectRow(item, { grouped = false } = {}) {
    const row = button('row', () => { void openProject(item); });
    const text = rowText(item.name, projectSourceLabel(item));
    text.lastElementChild.className = grouped ? 'project-source sr-only' : 'project-source';
    const location = document.createElement('small');
    location.className = 'project-path';
    location.textContent = projectLocation(item);
    text.append(location);
    row.dataset.kind = item.kind;
    if (grouped) {
      row.dataset.grouped = 'true';
      row.setAttribute('aria-label', [item.name, projectSourceLabel(item), location.textContent].join(' '));
    } else row.append(tile(item.kind === 'ssh' ? 'host' : 'folder'));
    row.append(text);
    const sessions = state.sessionCount(item.id);
    if (sessions) {
      const badge = document.createElement('span');
      badge.className = 'row-badge';
      badge.textContent = t('{n} 个会话', { n: sessions });
      row.append(badge);
    }
    row.append(icon('chevron', 'arrow'));
    // 左滑露出「复制」，长按同样展开；行本身的点按仍是打开项目。
    const wrapper = document.createElement('div');
    wrapper.className = 'project-row';
    const copy = button('swipe-action project-copy', async () => {
      await copyProjectPath(item);
      swipe.close();
    });
    copy.setAttribute('aria-label', t('复制 {name} 的路径', { name: item.name }));
    const copyLabel = document.createElement('span');
    copyLabel.textContent = t('复制');
    copy.append(icon('copy'), copyLabel);
    const face = document.createElement('div');
    face.className = 'project-face';
    face.append(row);
    wrapper.append(copy, face);
    const swipe = attachSwipeReveal(wrapper, face);
    attachLongPress(row, swipe.open);
    return wrapper;
  }

  function toggleProjectGroup(key) {
    if (collapsedGroups.has(key)) collapsedGroups.delete(key);
    else collapsedGroups.add(key);
    try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups])); } catch { /* 折叠只是显示偏好。 */ }
    renderProjects();
  }

  /** 搜索时 forceOpen 展开全部分组，避免结果藏在折叠组里。 */
  function projectGroup(group, forceOpen) {
    const section = document.createElement('section');
    section.className = 'project-group';
    section.dataset.group = group.key;
    section.dataset.kind = group.kind;
    const open = forceOpen || !collapsedGroups.has(group.key);
    const head = button('project-group-head', () => toggleProjectGroup(group.key));
    head.disabled = forceOpen;
    head.setAttribute('aria-expanded', String(open));
    const label = document.createElement('span');
    label.className = 'project-group-label';
    label.textContent = group.label;
    const count = document.createElement('span');
    count.className = 'project-group-count';
    count.textContent = String(group.items.length);
    head.append(icon(group.kind === 'ssh' ? 'host' : 'folder', 'project-group-icon'), label, count, icon('chevron-down', 'project-group-chevron'));
    const rows = document.createElement('div');
    rows.className = 'rows';
    rows.hidden = !open;
    rows.replaceChildren(...group.items.map(item => projectRow(item, { grouped: true })));
    section.append(head, rows);
    return section;
  }

  function renderProjects() {
    const profile = state.profile();
    const query = get('search').value.trim().toLowerCase();
    const matching = state.projects().filter(item => matchesProject(item, query));
    const list = get('project-list');
    const groups = groupProjectsByHost(matching);
    if (groups.length > 1) list.replaceChildren(...groups.map(group => projectGroup(group, !!query)));
    else {
      // 只有一台主机时不需要分组标题，来源直接显示在行内。
      const rows = document.createElement('div');
      rows.className = 'rows';
      rows.replaceChildren(...matching.map(item => projectRow(item)));
      list.replaceChildren(rows);
    }
    const checking = state.hostState(profile) === 'checking';
    list.setAttribute('aria-busy', String(checking));
    get('refresh').disabled = !profile || checking;
    get('refresh').dataset.busy = String(checking);
    get('refresh').setAttribute('aria-label', checking ? t('正在读取项目') : t('刷新项目'));
    get('project-filters').hidden = !profile;
    // 已连接时当前电脑由顶栏说明，副标题只在需要引导时出现。
    get('project-subtitle').textContent = profile ? '' : t('请先在「连接」中配对电脑。');
    get('project-subtitle').hidden = !!profile;
    get('list-label').textContent = matching.length ? t('{n} 个项目', { n: matching.length })
      : state.loaded() ? (query ? t('没有匹配的项目') : t('没有已信任的项目'))
        : checking ? t('正在读取项目…') : '';
    get('project-swipe-hint').hidden = !matching.length;
    const empty = !matching.length && !checking;
    get('project-empty').hidden = !empty;
    const filtered = !!query;
    get('project-empty-title').textContent = !profile ? t('先连接一台电脑') : filtered ? t('没有匹配的项目') : t('暂无可用项目');
    get('project-empty-text').textContent = !profile ? t('配对后即可查看电脑上的已信任项目。')
      : filtered ? t('试试其他关键词，或清除搜索查看全部项目。')
        : state.loaded() ? t('在电脑端添加并信任项目，再回到这里刷新。') : t('检查电脑连接后重新读取项目。');
    get('project-empty-action').textContent = !profile ? t('前往连接') : filtered ? t('清除搜索') : t('重新读取');
  }

  function renderAll() {
    renderConnections();
    renderHome();
    renderProjects();
  }

  return { renderConnections, renderHome, renderProjects, renderAll, renderResume, renderConnectionStats };
}
