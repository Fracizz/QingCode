'use strict';

const get = id => document.getElementById(id);
const native = window.QingCodeNative;
const pairScreen = get('pair-screen');
const projectScreen = get('project-screen');
const terminalScreen = get('terminal-screen');
const requests = new Map();
const sessionPreference = 'qingcode:mobile-session:';
let requestId = 0;
let projects = [];
let kind = 'local';
let project = null;
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

function show(screen) {
  for (const item of [pairScreen, projectScreen, terminalScreen]) item.hidden = item !== screen;
}

function message(id, value) {
  const target = get(id);
  target.textContent = value;
  target.hidden = !value;
}

function returnToProjects() {
  leaveTerminal();
  get('session-menu').open = false;
  show(projectScreen);
}

window.qingBack = () => {
  if (!terminalScreen.hidden) {
    returnToProjects();
    return true;
  }
  if (get('connection-menu').open) {
    get('connection-menu').open = false;
    return true;
  }
  return false;
};

async function forget(reason = '') {
  leaveTerminal();
  await rpc('forget');
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(sessionPreference)) localStorage.removeItem(key);
  }
  projects = [];
  show(pairScreen);
  message('pair-error', reason);
}

function remoteLabel(item) {
  if (item.kind !== 'ssh') return item.host;
  return item.host === '192.168.252.107' ? '252.107' : item.host;
}

function renderProjects() {
  const query = get('search').value.trim().toLowerCase();
  const matching = projects.filter(item =>
    item.kind === kind && [item.name, item.path, item.host].some(value => value.toLowerCase().includes(query)));
  const list = get('project-list');
  list.replaceChildren();
  for (const item of matching) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project';
    const folder = document.createElement('span');
    folder.className = 'folder';
    folder.textContent = '▰';
    folder.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = item.name;
    const location = document.createElement('small');
    location.textContent = remoteLabel(item) + ' · ' + (item.kind === 'ssh' ? item.path.replace(/^ssh:\/\/[^/]+/, '') : item.path);
    title.append(name, location);
    const arrow = document.createElement('span');
    arrow.textContent = '›';
    arrow.setAttribute('aria-hidden', 'true');
    button.append(folder, title, arrow);
    button.addEventListener('click', () => { void openProject(item); });
    list.append(button);
  }
  get('list-label').textContent = matching.length
    ? matching.length + ' 个项目'
    : query ? '没有匹配的项目' : '当前环境没有已信任的项目';
  const sshHosts = [...new Set(projects.filter(item => item.kind === 'ssh').map(item => item.host))];
  get('hosts').querySelector('[data-kind="ssh"]').textContent =
    sshHosts.length === 1 && sshHosts[0] === '192.168.252.107' ? '252.107' : '远端';
}

async function refreshProjects() {
  get('connection-menu').open = false;
  message('project-error', '');
  get('connection-label').textContent = 'Windows · 连接中';
  try {
    projects = await rpc('projects');
    get('connection-label').textContent = '● Windows 已连接';
    renderProjects();
  } catch (error) {
    if (error.revoked) {
      await forget(error.message);
      return;
    }
    get('connection-label').textContent = 'Windows · 未连接';
    message('project-error', error.message + ' 可在右上角刷新重试。');
  }
}

get('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const field = get('pair-code');
  button.disabled = true;
  message('pair-error', '');
  try {
    await rpc('pair', { code: field.value.trim() });
    field.value = '';
    show(projectScreen);
    await refreshProjects();
  } catch (error) {
    message('pair-error', error.message);
  } finally {
    button.disabled = false;
  }
});
get('refresh').addEventListener('click', () => { void refreshProjects(); });
get('forget').addEventListener('click', () => {
  get('connection-menu').open = false;
  void forget();
});
get('search').addEventListener('input', renderProjects);
for (const button of get('hosts').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    kind = button.dataset.kind;
    for (const item of get('hosts').querySelectorAll('button')) {
      item.setAttribute('aria-pressed', String(item === button));
    }
    get('search').value = '';
    renderProjects();
  });
}

function setCtrl(value) {
  ctrl = value;
  get('special-keys').querySelector('[data-key="ctrl"]').setAttribute('aria-pressed', String(value));
}

function leaveTerminal() {
  terminalReady = false;
  if (inputTimer !== null) {
    clearTimeout(inputTimer);
    flushInput();
  }
  viewEpoch += 1;
  clearTimeout(resizing);
  selected = null;
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
    theme: { background: '#101714', foreground: '#e2ede5', cursor: '#a0dab6', selectionBackground: '#41624f' },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(get('viewport'));
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
  void rpc('resize', { id: selected, ...dimensions() }).catch(() => {
    // The next successful output poll reapplies the size on reconnect.
  });
}

async function openProject(item) {
  if (busy) return;
  busy = true;
  const epoch = ++viewEpoch;
  project = item;
  sessions = [];
  get('compose').value = '';
  get('terminal-name').textContent = item.name;
  get('terminal-host').textContent = remoteLabel(item);
  show(terminalScreen);
  makeTerminal();
  renderSessions();
  message('terminal-status', '正在连接终端…');
  try {
    const list = await rpc('sessions', { project: item.id });
    if (epoch !== viewEpoch) return;
    sessions = list;
    const previous = localStorage.getItem(sessionPreference + item.id);
    const existing = sessions.find(session => session.id === previous)
      ?? sessions.find(session => !session.exit)
      ?? sessions[0];
    if (existing) selectSession(existing);
    else await createSession(epoch);
  } catch (error) {
    if (epoch === viewEpoch) message('terminal-status', error.message);
  } finally {
    busy = false;
  }
}

function renderSessions() {
  get('session-count').textContent = '终端 ' + sessions.length;
  get('end-session').disabled = !selected;
  const list = get('sessions');
  list.replaceChildren();
  for (const [index, session] of sessions.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '终端 ' + (session.number ?? index + 1) + (session.exit ? ' · 已结束' : '');
    button.setAttribute('aria-current', String(session.id === selected));
    button.addEventListener('click', () => { if (!busy) selectSession(session); });
    list.append(button);
  }
}

async function createSession(epoch) {
  // Refresh first so a prior request with an uncertain result remains visible.
  const list = await rpc('sessions', { project: project.id });
  if (epoch !== viewEpoch) return;
  sessions = list;
  renderSessions();
  const session = await rpc('create', { project: project.id, ...dimensions() });
  if (epoch !== viewEpoch) return;
  sessions.push(session);
  selectSession(session);
}

function selectSession(session) {
  leaveTerminal();
  selected = session.id;
  localStorage.setItem(sessionPreference + project.id, session.id);
  const epoch = viewEpoch;
  makeTerminal();
  renderSessions();
  get('session-menu').open = false;
  message('terminal-status', '正在接入终端…');
  void poll(session, epoch);
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
      const data = await rpc('poll', { id: session.id, from: next });
      if (epoch !== viewEpoch) return;
      next = data.next;
      if (data.reset) {
        term.reset();
        term.writeln('[较早的输出已超出 Windows 缓存]');
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
        session.exit = data.exit;
        renderSessions();
        terminalReady = false;
        if (data.more) continue;
        message('terminal-status', data.exit.disconnected ? 'Windows 到远端的终端连接已中断。' : '终端已结束 · ' + data.exit.exitCode);
        return;
      }
      if (!terminalReady) {
        terminalReady = true;
        message('terminal-status', '● 会话中');
        sendSize();
      }
      backoff = 350;
    } catch (error) {
      if (epoch !== viewEpoch) return;
      terminalReady = false;
      if (error.revoked) {
        await forget(error.message);
        return;
      }
      if (error.message === '终端不存在。') {
        sessions = sessions.filter(item => item.id !== session.id);
        selected = null;
        renderSessions();
        message('terminal-status', error.message);
        return;
      }
      message('terminal-status', '连接中断，正在尝试接回会话。');
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
  const epoch = viewEpoch;
  if (!id || !pending) return;
  queuedInput += pending.length;
  inputChain = inputChain.then(async () => {
    try {
      for (let offset = 0; offset < pending.length;) {
        let end = Math.min(offset + 2048, pending.length);
        if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1])) end -= 1;
        await rpc('input', { id, data: pending.slice(offset, end) });
        offset = end;
      }
    } catch {
      if (epoch === viewEpoch) message('terminal-status', '输入提交结果未知。请检查终端输出后再重试。');
    } finally {
      queuedInput -= pending.length;
    }
  });
}

function sendInput(value) {
  if (!terminalReady) {
    message('terminal-status', '终端暂时不可输入。');
    return;
  }
  if (ctrl && /^[a-z]$/i.test(value)) {
    value = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
    setCtrl(false);
  }
  if (queuedInput + inputQueue.length + value.length > 32_768) {
    message('terminal-status', '输入过长，请分段粘贴。');
    return;
  }
  inputQueue += value;
  if (inputTimer === null) inputTimer = setTimeout(flushInput, 22);
}

get('back').addEventListener('click', returnToProjects);
get('new-session').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  const epoch = viewEpoch;
  get('session-menu').open = false;
  message('terminal-status', '正在新建终端…');
  try {
    await createSession(epoch);
  } catch (error) {
    if (epoch === viewEpoch) message('terminal-status', error.message);
  } finally {
    busy = false;
  }
});
get('end-session').addEventListener('click', async () => {
  if (busy || !selected) return;
  busy = true;
  const id = selected;
  const epoch = viewEpoch;
  get('session-menu').open = false;
  try {
    await rpc('end', { id });
    if (epoch !== viewEpoch) return;
    sessions = sessions.filter(item => item.id !== id);
    if (sessions.length) selectSession(sessions[0]);
    else returnToProjects();
  } catch (error) {
    if (epoch === viewEpoch) message('terminal-status', error.message);
  } finally {
    busy = false;
  }
});
const keys = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', enter: '\r' };
for (const button of get('special-keys').querySelectorAll('[data-key]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.key;
    if (key === 'ctrl') {
      setCtrl(!ctrl);
      term?.focus();
    } else {
      sendInput(keys[key]);
    }
  });
}
get('keyboard').addEventListener('click', () => term?.focus());
get('compose-form').addEventListener('submit', event => {
  event.preventDefault();
  const field = get('compose');
  if (terminalReady) {
    sendInput(field.value + '\r');
    field.value = '';
  }
});

if (native.paired()) {
  show(projectScreen);
  void refreshProjects();
}
