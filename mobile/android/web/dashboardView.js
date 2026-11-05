// 工作台三页的渲染：连接列表、首页（当前电脑与最近项目）、项目列表。只读取状态，不发请求。
import { matchesProject, projectSourceLabel, recentProjects } from './protocol.js';
import { get, icon, rowText, tile, button, avatar } from './dom.js';

/**
 * state：profile、profiles、projects、loaded 的 getter 与 hostState(item)；
 * lastProject() / projectHistory() 读手机记录；activate / openPair / openHost / openProject 为点击动作。
 */
export function createDashboardView({ state, lastProject, projectHistory, syncLatency, activate, openPair, openHost, openProject }) {
  function renderConnections() {
    const profile = state.profile();
    const list = get('connection-list');
    list.replaceChildren();
    get('connection-empty').hidden = state.profiles().length > 0;
    for (const item of [...state.profiles()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id))) {
      const current = item.id === profile?.id;
      const hostState = state.hostState(item);
      const labels = { saved: '已配对', checking: '连接中…', online: '已连接', offline: '连接失败', expired: '需要重新配对' };
      const card = document.createElement('div');
      card.className = 'connection-card';
      card.dataset.current = String(current);
      card.dataset.state = hostState === 'expired' ? 'offline' : hostState;
      const select = button('connection-main', () => {
        if (hostState === 'expired') openPair(item);
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
      status.textContent = labels[hostState] + (current ? ' · 当前电脑' : '');
      text.append(status);
      select.append(avatar(item.name), text, dot);
      card.append(select, detail);
      list.append(card);
    }
    get('active-host-name').textContent = profile?.name ?? '未连接';
    const hostState = state.hostState(profile);
    get('active-host').dataset.state = hostState === 'expired' ? 'offline' : hostState;
    get('active-host').setAttribute('aria-label', profile ? '切换连接，当前为 ' + profile.name : '管理连接');
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
    get('home-context').hidden = !profile;
    get('home-context').dataset.state = hostState === 'expired' ? 'offline' : hostState;
    get('home-context-name').textContent = profile?.name ?? '';
    get('home-context-state').textContent = {
      online: projects.length + ' 个已信任项目 · 可以打开终端',
      checking: '正在读取项目…', offline: '电脑暂时不可达', expired: '配对已失效', saved: '等待连接',
    }[hostState];
    get('home-reconnect').hidden = hostState !== 'offline';
    if (canResume) {
      get('resume-name').textContent = recent.name;
      get('resume-host').textContent = profile.name + ' / ' + projectSourceLabel(recent);
    }
    const recentList = recentProjects(projects, projectHistory());
    get('home-projects').hidden = hostState !== 'online' || !projects.length;
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
    const [title, description, action] = homeStates[hostState];
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
    const profile = state.profile();
    const query = get('search').value.trim().toLowerCase();
    const matching = state.projects().filter(item => matchesProject(item, query));
    const list = get('project-list');
    list.replaceChildren(...matching.map(projectRow));
    const checking = state.hostState(profile) === 'checking';
    list.setAttribute('aria-busy', String(checking));
    get('refresh').disabled = !profile || checking;
    get('refresh').dataset.busy = String(checking);
    get('refresh').setAttribute('aria-label', checking ? '正在读取项目' : '刷新项目');
    get('project-filters').hidden = !profile;
    get('project-subtitle').textContent = profile ? profile.name + ' · 已信任项目' : '请先在「连接」中配对电脑。';
    get('list-label').textContent = matching.length ? matching.length + ' 个项目'
      : state.loaded() ? (query ? '没有匹配的项目' : '没有已信任的项目')
        : checking ? '正在读取项目…' : '';
    const empty = !matching.length && !checking;
    get('project-empty').hidden = !empty;
    const filtered = !!query;
    get('project-empty-title').textContent = !profile ? '先连接一台电脑' : filtered ? '没有匹配的项目' : '暂无可用项目';
    get('project-empty-text').textContent = !profile ? '配对后即可查看电脑上的已信任项目。'
      : filtered ? '试试其他关键词，或清除搜索查看全部项目。'
        : state.loaded() ? '在电脑端添加并信任项目，再回到这里刷新。' : '检查电脑连接后重新读取项目。';
    get('project-empty-action').textContent = !profile ? '前往连接' : filtered ? '清除搜索' : '重新读取';
  }

  function renderAll() {
    renderConnections();
    renderHome();
    renderProjects();
  }

  return { renderConnections, renderHome, renderProjects, renderAll };
}
