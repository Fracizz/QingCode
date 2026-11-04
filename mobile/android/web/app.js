'use strict';

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
let terminalReady = false;
let ctrl = false;
let busy = false;
let inputQueue = '';
let inputTimer = null;
let inputChain = Promise.resolve();
let queuedInput = 0;
let resizing = null;
let editing = null;
let composing = false;

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
  for (const id of ['confirm-dialog', 'pair-confirm', 'host-dialog', 'pair-dialog', 'session-dialog']) {
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
    select.append(tile('host'), rowText(item.name, item.id + ' · ' + labels[state] + (current ? ' · 当前' : '')), dot);
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

const kindLabels = { local: '本机', wsl: 'WSL', ssh: '远端' };

function renderHome() {
  const recent = lastProject();
  get('resume').hidden = !recent;
  get('browse-projects').hidden = !recent;
  get('home-empty').hidden = !!recent;
  const state = hostState(profile);
  if (recent) {
    get('resume-name').textContent = recent.name;
    get('resume-host').textContent = profile.name + ' / ' + recent.host;
  }
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

function renderProjects() {
  const query = get('search').value.trim().toLowerCase();
  const matching = projects.filter(item =>
    (kind === 'all' || item.kind === kind) && [item.name, item.path, item.host].some(value => value.toLowerCase().includes(query)));
  const list = get('project-list');
  list.replaceChildren();
  for (const item of matching) {
    const path = item.kind === 'ssh' ? item.path.replace(/^ssh:\/\/[^/]+/, '') : item.path;
    const row = button('row', () => { void openProject(item); });
    row.append(tile('folder'), rowText(item.name, kindLabels[item.kind] + ' · ' + path), icon('chevron', 'arrow'));
    list.append(row);
  }
  get('refresh').disabled = !profile || hostState(profile) === 'checking';
  get('project-filters').hidden = !profile;
  get('project-subtitle').textContent = profile ? profile.name + ' · 已信任项目' : '请先在「连接」中配对电脑。';
  get('list-label').textContent = matching.length ? matching.length + ' 个项目'
    : loaded ? (query ? '没有匹配的项目' : '当前环境没有已信任的项目')
      : hostState(profile) === 'checking' ? '正在读取项目…' : '';
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

function openPair(item) {
  const dialog = get('pair-dialog');
  get('host-dialog').close();
  get('pair-title').textContent = item ? '重新配对' : '添加连接';
  get('pair-name').value = item?.name ?? '';
  get('pair-host').value = item?.host ?? '';
  get('pair-port').value = item?.port ?? '48764';
  get('pair-code').value = '';
  get('pair-host').readOnly = !!item;
  get('pair-port').readOnly = !!item;
  message('pair-error', '');
  dialog.showModal();
}

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
    if (!/^[!-~]{6,20}$/.test(code)) {
      throw new Error('密码须为 6–20 位，可使用数字、英文字母或符号，无需组合。');
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const fingerprint = await rpc('probe', { host, port });
    const saved = profiles.find(item => item.id === host + ':' + port);
    if (saved?.fingerprint !== fingerprint) {
      get('pair-fingerprint').textContent = fingerprint;
      if (!await ask(get('pair-confirm'))) return;
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
    putProfile(await rpc('rename', { profile: item.id, name }));
    renderConnections();
    renderHome();
    renderProjects();
    if (editing?.id === item.id) get('host-dialog').close();
  } catch (error) {
    if (editing?.id === item.id) message('host-error', error.message);
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

function setCtrl(value) {
  ctrl = value;
  get('special-keys').querySelector('[data-key="ctrl"]').setAttribute('aria-pressed', String(value));
}

function setRawKeyboard(enabled) {
  if (term?.textarea) term.textarea.inputMode = enabled ? 'text' : 'none';
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
  setCtrl(false);
  term?.dispose();
  term = undefined;
  fit = undefined;
}

function makeTerminal() {
  term = new window.Terminal({
    allowProposedApi: false,
    fontSize: 13,
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
  setRawKeyboard(false);
  term.textarea.addEventListener('blur', () => setRawKeyboard(false));
  fit.fit();
  term.onData(data => sendInput(data));
  term.onResize(() => {
    clearTimeout(resizing);
    resizing = setTimeout(sendSize, 120);
  });
}

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
  get('terminal-host').textContent = profile.name + ' / ' + (item.host || kindLabels[item.kind]);
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

function decode(chunk) {
  return Uint8Array.from(atob(chunk), character => character.charCodeAt(0));
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
      for (const chunk of data.chunks) {
        if (epoch !== viewEpoch) return;
        const view = term;
        const screen = typeof chunk !== 'string';
        if (screen) {
          view.reset();
          view.resize(chunk.cols, chunk.rows);
        }
        await new Promise(resolve => {
          // Disposing the renderer can drop its pending write callback.
          const fallback = setTimeout(resolve, 250);
          view.write(decode(screen ? chunk.data : chunk), () => { clearTimeout(fallback); resolve(); });
        });
        if (screen && epoch === viewEpoch) fit.fit();
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
      for (let offset = 0; offset < pending.length;) {
        let end = Math.min(offset + 2048, pending.length);
        if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1])) end -= 1;
        await remote('input', { id, data: pending.slice(offset, end) }, address);
        offset = end;
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
  if (ctrl) {
    if (/^[a-z]$/i.test(value)) value = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
    setCtrl(false);
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

const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
for (const keyButton of get('special-keys').querySelectorAll('[data-key]')) {
  keyButton.addEventListener('pointerdown', event => {
    if (document.activeElement === compose || document.activeElement === term?.textarea) event.preventDefault();
  });
  keyButton.addEventListener('click', () => {
    const key = keyButton.dataset.key;
    if (key === 'ctrl') {
      setCtrl(!ctrl);
      if (ctrl) focusRawKeyboard();
    } else if (key === 'esc' || key === 'tab') {
      sendInput(key === 'esc' ? '\x1b' : '\t');
    } else {
      sendInput((term?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrows[key]);
    }
  });
}
get('keyboard').addEventListener('click', focusRawKeyboard);
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
