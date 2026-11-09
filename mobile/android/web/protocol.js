// QingCode Android 的纯逻辑：配对链接、终端输出块、输入拆分与按键序列。
// app.js 与 Vitest（src/lib/mobileAndroidProtocol.test.ts）共用，不得访问 DOM。
import { t } from './i18n.js';

export const PAIRING_PREFIX = 'qingcode://pair?';
export const DEFAULT_PORT = 48764;
export const INPUT_SLICE = 2048;

/**
 * 选字工具栏「添加到对话」：把终端选中文本转成 Markdown 引用（与电脑端 terminalQuote.ts 一致）。
 * 选区为空白时返回空串；末尾带空行，用户在引用下方接着补充问题后自己发送。
 */
export function formatTerminalQuote(selection) {
  const lines = String(selection ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // xterm 选区按网格取文本，行尾常带填充空格。
    .map(line => line.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return '';
  return `${lines.map(line => (line ? `> ${line}` : '>')).join('\n')}\n`;
}

/** Dimensions are the viewport's content box, with padding already deducted. */
export function terminalGridSize(width, height, cellWidth, cellHeight, fixedColumns = 0) {
  if (![width, height, cellWidth, cellHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  return {
    cols: Math.max(2, Math.min(300, fixedColumns || Math.floor(width / cellWidth))),
    rows: Math.max(2, Math.min(150, Math.floor(height / cellHeight))),
  };
}

/** 接入时后端画面的网格和本机不同：要先改尺寸等程序重绘，不能直接显示旧尺寸的画面。 */
export function attachNeedsRedraw(snapshot, local) {
  return Number.isFinite(snapshot?.cols) && Number.isFinite(snapshot?.rows)
    && (snapshot.cols !== local.cols || snapshot.rows !== local.rows);
}

/**
 * 程序标题开头的转圈帧字符：盲文点阵（含空白帧 U+2800）与圆形/方块转圈。
 * 须与电脑端 `is_spinner_glyph`（src-tauri/src/mobile.rs）保持一致。
 */
const SPINNER_PREFIX = /^[\u2800-\u28ff\u25d0-\u25d3\u25e2-\u25e5\u25f0-\u25f7]\s*/u;
const SPINNER_START = /^[\u2800-\u28ff\u25d0-\u25d3\u25e2-\u25e5\u25f0-\u25f7]/u;
// Claude Code \u7b49\u7a0b\u5e8f\u5728\u6807\u9898\u524d\u52a0\u7684\u661f\u5f62\u7b26\u53f7\uff08\u2722 \u2733 \u2736 \u273b \u273d\uff09\u3002
const TITLE_DECORATION = /^[\u2722\u2733\u2736\u273b\u273d]\ufe0f?\s*/u;

export function sessionName(session, fallback = 1) {
  const name = typeof session?.name === 'string' ? session.name.trim() : '';
  // CLI title animations belong in a status icon, never in the session name.
  // 转圈帧和程序加在标题前的 ✳ 这类装饰符都不算名称；运行状态由独立图标表达。
  const shown = session?.customName ? name : name.replace(SPINNER_PREFIX, '').replace(TITLE_DECORATION, '');
  // 电脑端没有程序标题时默认命名为「终端 N」，按手机语言显示；手动名称保持原样。
  const numbered = !session?.customName && /^终端 (\d+)$/.exec(shown);
  if (numbered) return t('终端 {n}', { n: numbered[1] });
  return shown || t('终端 {n}', { n: session?.number ?? fallback });
}

/**
 * A live PTY alone does not imply that its CLI is working.
 * 新版电脑端给出按时间窗口平滑过的 programBusy，避免轮询取到空白帧或短暂的普通标题时转圈时转时停；
 * 旧版电脑端没有该字段时退回按当前标题判断。
 */
export function sessionRunning(session) {
  if (session?.exit) return false;
  if (typeof session?.programBusy === 'boolean') return session.programBusy;
  const title = session?.programTitle ?? (session?.customName ? '' : session?.name);
  return SPINNER_START.test(String(title ?? '').trim());
}

/**
 * 忙碌状态不随名称版本号走：保持时间到期时名称不变，不能被版本号挡住。返回是否有变化。
 */
export function mergeSessionActivity(session, incoming) {
  if (!session || typeof incoming?.programBusy !== 'boolean') return false;
  if (Number.isFinite(incoming.activityRevision)) {
    if (incoming.activityRevision < (session.activityRevision ?? -1)) return false;
    session.activityRevision = incoming.activityRevision;
  } else if (Number.isFinite(session.activityRevision)) return false;
  if (session.programBusy === incoming.programBusy) return false;
  session.programBusy = incoming.programBusy;
  return true;
}

/** Late poll responses must not undo a newer manual rename. */
export function mergeSessionList(list, previous) {
  const saved = new Map(previous.map(session => [session.id, session]));
  return list.map(session => {
    const current = saved.get(session.id);
    if (current) {
      mergeSessionName(session, current);
      mergeSessionActivity(session, current);
      session.exit ??= current.exit;
    }
    return session;
  });
}

export function mergeSessionName(session, incoming) {
  if (!Number.isFinite(incoming?.nameRevision) || incoming.nameRevision < (session.nameRevision ?? -1)) return false;
  const changed = session.name !== incoming.name || session.customName !== incoming.customName
    || session.programTitle !== incoming.programTitle;
  session.name = incoming.name;
  session.customName = incoming.customName;
  session.programTitle = incoming.programTitle;
  session.nameRevision = incoming.nameRevision;
  return changed;
}

// 会话置顶只保存在手机本地（按连接 + 项目），不改变电脑端终端顺序。
export const SESSION_PIN_LIMIT = 50;

/** 读取本地置顶列表：容错损坏数据，去重并限制数量。 */
export function parseSessionPins(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(id => typeof id === 'string' && id))].slice(0, SESSION_PIN_LIMIT);
  } catch {
    return [];
  }
}

/** 切换置顶；新置顶的会话排在最前。 */
export function toggleSessionPin(pins, id) {
  return pins.includes(id) ? pins.filter(item => item !== id) : [id, ...pins].slice(0, SESSION_PIN_LIMIT);
}

/** 丢弃电脑端已不存在的会话，只在拿到完整会话列表后调用。 */
export function prunedSessionPins(pins, sessions) {
  const live = new Set(sessions.map(session => session.id));
  return pins.filter(id => live.has(id));
}

/**
 * 显示顺序：置顶会话按置顶顺序在前；按下「运行中优先」时其余运行中（程序在工作）的排前面，否则按手动顺序 order，再保持电脑端顺序。
 * 没有手动顺序记录的新会话排在已排序会话之后。
 * 返回 { session, index }，index 是原列表位置，用于「终端 N」兜底名称。
 */
export function orderSessions(sessions, pins = [], { runningFirst = false, order = [] } = {}) {
  const rank = new Map(pins.map((id, index) => [id, index]));
  const custom = new Map((runningFirst ? [] : order).map((id, index) => [id, index]));
  const position = id => custom.get(id) ?? custom.size;
  return sessions.map((session, index) => ({ session, index }))
    .sort((a, b) => (rank.get(a.session.id) ?? pins.length) - (rank.get(b.session.id) ?? pins.length)
      || (runningFirst ? Number(sessionRunning(b.session)) - Number(sessionRunning(a.session)) : 0)
      || position(a.session.id) - position(b.session.id)
      || a.index - b.index);
}
/** 会话纵览筛选：全部 / 未结束 / 已结束。 */
export const OVERVIEW_FILTERS = ['all', 'live', 'exited'];

/** 纵览各筛选项的会话数。 */
export function countSessionOverview(list) {
  const items = Array.isArray(list) ? list : [];
  const exited = items.filter(session => session?.exit).length;
  return { all: items.length, live: items.length - exited, exited };
}

/** 会话创建时间；缺失（旧版电脑端、部分电脑终端）时为 0，排在有创建时间的会话之后。 */
function createdTime(session) {
  return Number.isFinite(session?.createdAt) ? session.createdAt : 0;
}

/**
 * 会话纵览：把电脑端返回的全部手机会话按项目分组。
 * 当前项目排第一，其余按手机/电脑的最近打开时间，再按项目名；组内新创建的在上，旧版电脑端没有创建时间时按编号倒序（runningFirst 时运行中的排最前）。
 * 电脑端项目列表中仍存在的项目使用列表里的完整信息（含连接名），否则用会话自带的项目信息并标记 missing。
 * query 以空白分隔的多个关键词需全部命中（会话名、项目名、来源、创建设备），不区分大小写。
 * order（侧栏）：常驻项目的固定顺序。给出后切换项目不再改变分组位置，常驻项目没有会话时也显示空分组（筛选、搜索时除外）；
 * 只因电脑终端而显示的项目排在常驻项目之后，按项目名排序。
 * sessionOrder(projectId)（侧栏）：组内手动顺序；新会话排在已排序会话之前，与默认的新建在上一致；「运行中优先」时不生效。
 */
export function groupSessionOverview(list, { projects = [], current = null, history = [], filter = 'all', query = '', runningFirst = false, order = null, sessionOrder = null } = {}) {
  const known = new Map(projects.map(project => [project.id, project]));
  const times = new Map();
  for (const item of Array.isArray(history) ? history : []) {
    if (item && typeof item.id === 'string' && Number.isFinite(item.openedAt)) times.set(item.id, Math.max(times.get(item.id) || 0, item.openedAt));
  }
  const opened = project => Math.max(times.get(project.id) || 0, Number.isFinite(project.lastOpenedAt) ? project.lastOpenedAt : 0);
  const needles = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map();
  for (const session of Array.isArray(list) ? list : []) {
    const id = session?.project?.id;
    if (typeof id !== 'string') continue;
    if (filter === 'live' && session.exit) continue;
    if (filter === 'exited' && !session.exit) continue;
    const project = known.get(id) ?? { ...session.project };
    if (needles.length) {
      const haystack = [sessionName(session), project.name, projectSourceLabel(project), session.deviceName ?? '']
        .join('\n').toLowerCase();
      if (!needles.every(needle => haystack.includes(needle))) continue;
    }
    let group = groups.get(id);
    if (!group) groups.set(id, group = { project, missing: !known.has(id), sessions: [] });
    group.sessions.push(session);
  }
  for (const [id, group] of groups) {
    const custom = new Map((sessionOrder && !runningFirst ? sessionOrder(id) : []).map((item, index) => [item, index]));
    const position = session => custom.get(session.id) ?? -1;
    group.sessions.sort((a, b) => (runningFirst ? Number(sessionRunning(b)) - Number(sessionRunning(a)) : 0)
      || position(a) - position(b)
      || createdTime(b) - createdTime(a)
      || (b.number ?? 0) - (a.number ?? 0));
  }
  const byName = (a, b) => String(a.project.name ?? '').localeCompare(String(b.project.name ?? ''))
    || a.project.id.localeCompare(b.project.id);
  if (order) {
    if (filter === 'all' && !needles.length) {
      for (const id of order) if (!groups.has(id) && known.has(id)) groups.set(id, { project: known.get(id), missing: false, sessions: [] });
    }
    const rank = new Map(order.map((id, index) => [id, index]));
    const position = group => rank.get(group.project.id) ?? order.length;
    return [...groups.values()]
      .sort((a, b) => position(a) - position(b) || byName(a, b))
      .map(group => ({ ...group, member: rank.has(group.project.id) }));
  }
  return [...groups.values()].sort((a, b) =>
    Number(b.project.id === current) - Number(a.project.id === current)
    || opened(b.project) - opened(a.project)
    || byName(a, b));
}

// 侧栏常驻项目只保存在手机本地（按连接），不改变电脑端的项目列表和顺序。
export const SIDEBAR_PROJECT_LIMIT = 100;

/** 读取本地保存的 id 列表（常驻项目、折叠项目、终端手动顺序）：容错损坏数据，去重并限制数量。 */
export function parseIdList(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(id => typeof id === 'string' && id))].slice(0, SIDEBAR_PROJECT_LIMIT);
  } catch {
    return [];
  }
}

/** 新项目追加在末尾，已有项目保持原位。 */
export function joinProjectIds(order, ids) {
  return [...new Set([...order, ...ids])].slice(0, SIDEBAR_PROJECT_LIMIT);
}

/** 拖动排序：只在当前可见的项目之间换位，暂时看不到的项目（如电脑端已取消信任）留在原位。 */
export function reorderVisibleProjects(order, visible, from, to) {
  const next = [...visible];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const slots = new Set(visible);
  let index = 0;
  return order.map(id => (slots.has(id) ? next[index++] : id));
}

/** 终端拖动排序：可见的终端按新顺序排在前面，其余已保存的（如另一范围才显示的）放在后面，超限时先丢弃它们。 */
export function reorderSessionIds(saved, visible, from, to) {
  const next = [...visible];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return [...next, ...saved.filter(id => !visible.includes(id))].slice(0, SIDEBAR_PROJECT_LIMIT);
}

/** 手机会话所在的项目，自动加入侧栏；只有电脑终端的项目不加入，这些终端结束后项目自然消失。 */
export function phoneSessionProjectIds(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .filter(session => session?.origin !== 'desktop' && typeof session?.project?.id === 'string')
    .map(session => session.project.id))];
}

/**
 * 「有新结果」：看不到的会话从工作转为停下（含退出）时标记，看过或重新开始工作时清除。
 * tracker 为 { busy: Set, attention: Set }，只存内存，与电脑端语义一致。
 */
export function updateSessionAttention({ busy, attention }, list, selected) {
  for (const session of Array.isArray(list) ? list : []) {
    if (sessionRunning(session)) {
      busy.add(session.id);
      attention.delete(session.id);
    } else if (busy.delete(session.id) && session.id !== selected) {
      attention.add(session.id);
    }
  }
  attention.delete(selected);
}

/**
 * 首页只先显示前 limit 个会话：按分组顺序截取，跨组时保留组头；hidden 为未显示的会话数。
 * 被截取的组保留 total（该项目的会话总数），组头仍显示完整数量。
 * limit 不是有限正数时不截取。
 */
export function limitSessionGroups(groups, limit) {
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  if (!Number.isFinite(limit) || limit <= 0 || total <= limit) return { groups, hidden: 0 };
  const shown = [];
  let left = Math.floor(limit);
  for (const group of groups) {
    if (left <= 0) break;
    const sessions = group.sessions.slice(0, left);
    left -= sessions.length;
    shown.push({ ...group, sessions, total: group.sessions.length });
  }
  return { groups: shown, hidden: total - Math.floor(limit) };
}

/** 批量关闭前的统计：总数、运行中、已结束、其他设备创建的运行中会话、涉及项目数。 */
export function summarizeSessionBatch(list) {
  const items = Array.isArray(list) ? list : [];
  const running = items.filter(item => !item?.exit);
  return {
    total: items.length,
    running: running.length,
    ended: items.length - running.length,
    others: running.filter(item => item?.ownDevice === false).length,
    projects: new Set(items.map(item => item?.project?.id)).size,
  };
}

/** 多选状态随列表刷新：去掉已不存在的会话，保持原选择顺序。 */
export function prunedSelection(selection, list) {
  const ids = new Set((Array.isArray(list) ? list : []).map(item => item?.id));
  return new Set([...selection].filter(id => ids.has(id)));
}

/** 全部会话列表里属于某个项目的部分，去掉纵览附带的项目与设备字段，与按项目请求的结果一致。 */
export function projectSessionsFromOverview(list, projectId) {
  return (Array.isArray(list) ? list : [])
    // 电脑终端只在纵览里出现，不进入本项目的手机会话列表（结束全部等操作都基于它）。
    .filter(session => session?.project?.id === projectId && session.origin !== 'desktop')
    .map(item => {
      const session = { ...item };
      delete session.project;
      delete session.deviceName;
      delete session.ownDevice;
      return session;
    });
}

export const RECENT_PROJECT_LIMIT = 10;

export function rememberProject(history, id, openedAt = Date.now()) {
  const entries = Array.isArray(history) ? history : [];
  return [{ id, openedAt }, ...entries.filter(item => item && item.id !== id
    && typeof item.id === 'string' && Number.isFinite(item.openedAt) && item.openedAt > 0)]
    .slice(0, RECENT_PROJECT_LIMIT);
}

/** Only current trusted projects qualify; desktop and phone opens share the ordering. */
export function recentProjects(projects, history) {
  const times = new Map();
  for (const item of Array.isArray(history) ? history : []) {
    if (item && typeof item.id === 'string' && Number.isFinite(item.openedAt) && item.openedAt > 0)
      times.set(item.id, Math.max(times.get(item.id) || 0, item.openedAt));
  }
  const timestamp = project => Math.max(times.get(project.id) || 0,
    Number.isFinite(project.lastOpenedAt) && project.lastOpenedAt > 0 ? project.lastOpenedAt : 0);
  return projects.filter(project => timestamp(project) > 0)
    .sort((a, b) => timestamp(b) - timestamp(a)).slice(0, RECENT_PROJECT_LIMIT);
}

/** 保留连接名称和实际主机；连接名为 WSL 的 SSH 项目仍使用远端通道。 */
export function projectSourceLabel(project) {
  const kind = { local: t('本机'), wsl: 'WSL', ssh: t('远端') }[project.kind] || t('项目');
  const parts = project.kind === 'local' ? [kind] : [kind, project.connectionName, project.host];
  return [...new Set(parts.filter(Boolean))].join(' · ');
}

/**
 * 项目路径的显示形式：去掉 ssh:// 资源前缀；远端 Windows 的 `/D:/code/x` 按用户习惯显示为 `D:\code\x`。
 * 只用于显示和搜索，打开项目仍使用原始路径。
 */
export function projectLocation(project) {
  const path = String(project?.path ?? '');
  const location = project?.kind === 'ssh' ? path.replace(/^ssh:\/\/[^/]+/, '') : path;
  return /^\/[A-Za-z]:(\/|$)/.test(location) ? location.slice(1).replaceAll('/', '\\') : location;
}

/** 按所在主机分组，组和组内项目都保持电脑端给出的顺序；同一连接名和地址算同一台主机。 */
export function groupProjectsByHost(projects) {
  const groups = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    const key = project.kind === 'local' ? 'local' : [project.kind, project.connectionName ?? '', project.host ?? ''].join('\n');
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, kind: project.kind, label: projectSourceLabel(project), items: [] });
    group.items.push(project);
  }
  return [...groups.values()];
}

export function matchesProject(project, query) {
  const search = query.trim().toLowerCase();
  return [project.name, project.path, projectLocation(project), projectSourceLabel(project)].some(value => String(value ?? '').toLowerCase().includes(search));
}

export function validIpv4(host) {
  const octets = String(host).split('.');
  return octets.length === 4 && octets.every(octet => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
}

export function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 解析 Windows 设置页生成的配对链接（见 src/lib/mobilePairing.ts）。 */
export function parsePairingLink(text) {
  const value = String(text ?? '').trim();
  if (!value.startsWith(PAIRING_PREFIX)) throw new Error(t('这不是 QingCode 配对链接。'));
  const query = new URLSearchParams(value.slice(PAIRING_PREFIX.length));
  if (query.get('v') !== '1') throw new Error(t('配对链接版本不受支持，请升级 QingCode Android。'));
  const host = query.get('host') ?? '';
  const port = Number(query.get('port'));
  const fingerprint = (query.get('fp') ?? '').toLowerCase();
  if (!validIpv4(host) || !validPort(port)) throw new Error(t('配对链接中的地址无效。'));
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error(t('配对链接中的证书指纹无效。'));
  const name = (query.get('name') ?? '').trim().slice(0, 48) || 'Windows';
  return { host, port, fingerprint, name };
}

export function decodeBase64(chunk) {
  return Uint8Array.from(atob(chunk), character => character.charCodeAt(0));
}

/**
 * 普通输出块是 base64 字节；屏幕快照是 `{ data, cols, rows }`，data 为可直接写入 xterm 的终端文本。
 */
export function outputChunk(chunk) {
  if (typeof chunk === 'string') return { screen: false, data: decodeBase64(chunk) };
  return { screen: true, data: String(chunk.data), cols: chunk.cols, rows: chunk.rows };
}

/**
 * 把一次轮询返回的块整理成写入批次：相邻字节块拼成一次写入，屏幕快照单独成批。
 * 一次写入只渲染最终画面，避免连续多帧动画挤在一起刷新或露出半帧。
 */
export function outputBatches(chunks) {
  const batches = [];
  let parts = [];
  const flush = () => {
    if (!parts.length) return;
    const data = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    batches.push({ screen: false, data });
    parts = [];
  };
  for (const raw of chunks) {
    const chunk = outputChunk(raw);
    if (chunk.screen) { flush(); batches.push(chunk); } else parts.push(chunk.data);
  }
  flush();
  return batches;
}

/** 按 UTF-16 长度切片，不拆开代理对。 */
export function splitInput(text, size = INPUT_SLICE) {
  const parts = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

const CONTROL_SYMBOLS = { '@': 0, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, '?': 127 };

/** 一次性 Ctrl / Alt：Ctrl 映射单个字母或符号，Alt 以 ESC 前缀发送。 */
export function applyModifiers(value, { ctrl = false, alt = false } = {}) {
  let result = value;
  if (ctrl && result.length === 1) {
    if (/^[a-z]$/i.test(result)) result = String.fromCharCode(result.toUpperCase().charCodeAt(0) & 31);
    else if (result in CONTROL_SYMBOLS) result = String.fromCharCode(CONTROL_SYMBOLS[result]);
  }
  if (alt && result.length > 0) result = '\x1b' + result;
  return result;
}

/** 双击判定窗口（毫秒），参考 Termux extra-keys 的修饰键锁定手势。 */
export const MODIFIER_LOCK_WINDOW = 350;

/**
 * 修饰键三态：off → once（单次）→ 窗口内再点 → lock（锁定）；once 超时再点或 lock 再点均回到 off。
 * 返回 { state, at }，at 为本次点击时间，供下一次判定双击。
 */
export function nextModifierState(current, now, lastTap = -Infinity) {
  if (current === 'once' && now - lastTap <= MODIFIER_LOCK_WINDOW) return { state: 'lock', at: now };
  if (current === 'off' || !current) return { state: 'once', at: now };
  return { state: 'off', at: now };
}

/** 发送一次输入后：单次修饰键复位，锁定保持。 */
export function consumeModifier(state) {
  return state === 'lock' ? 'lock' : 'off';
}

/** 下拉刷新：带阻尼的位移与触发阈值（像素）。 */
export const PULL_THRESHOLD = 64;
export const PULL_MAX = 96;

export function pullOffset(distance) {
  if (!(distance > 0)) return 0;
  // 越拉越难：前段近似 1:2，靠近上限时趋缓。
  return Math.round(PULL_MAX * (1 - Math.exp(-distance / (PULL_MAX * 1.25))));
}

/** 列表行左滑露出操作：跟手位移，越过全开位置后加阻尼，向右不越过原位。 */
export function swipeRevealOffset(base, distance, width) {
  const offset = base + distance;
  if (offset >= 0) return 0;
  if (offset >= -width) return offset;
  return -width + (offset + width) / 3;
}

/** 松手时是否停在展开位置：露出超过一半即展开。 */
export function swipeRevealSettles(offset, width) {
  return offset <= -width / 2;
}

const AVATAR_HUES = 6;

/** 连接头像：取名称首个字母/汉字（英文取前两个单词首字母），色相由名称稳定散列得出。 */
export function avatarFor(name) {
  const text = String(name ?? '').trim();
  const words = text.split(/[\s_\-.]+/).filter(Boolean);
  const initials = words.length > 1 && /^[a-z0-9]/i.test(words[0]) && /^[a-z0-9]/i.test(words[1])
    ? words[0][0] + words[1][0]
    : Array.from(text)[0] ?? '?';
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return { initials: initials.toUpperCase(), hue: hash % AVATAR_HUES };
}

const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE_KEYS = { pgup: '5~', pgdn: '6~' };

export function keySequence(key, { applicationCursor = false, inputLine = '' } = {}) {
  if (key === 'esc') return '\x1b';
  if (key === 'tab') return '\t';
  if (key === 'shift-tab') return '\x1b[Z';
  if (key === 'backspace') return '\x7f';
  if (key === 'delete-word') return '\x17';
  if (key === 'delete-line-start') return '\x15';
  // Windows PSReadLine 默认不绑定 Ctrl+E / Ctrl+U。只在当前输入行明确是
  // PowerShell 提示符时使用其 Ctrl+Home / Ctrl+End，不能按项目来源猜前台程序。
  if (key === 'clear-input') return /^PS (?:[a-z]:[\\/]|\\\\)[^\r\n]*>/i.test(inputLine)
    ? '\x1b[1;5H\x1b[1;5F' : '\x05\x15';
  if (key === 'newline') return '\n';
  if (key in TILDE_KEYS) return '\x1b[' + TILDE_KEYS[key];
  if (key in ARROWS) return (applicationCursor ? '\x1bO' : '\x1b[') + ARROWS[key];
  throw new Error('unknown key ' + key);
}

/** 连接地址变化（如电脑端改端口）时，迁移以连接 id 为键的本地记录。 */
export function renameProfileKeys(keys, prefix, from, to) {
  const moves = [];
  for (const key of keys) {
    for (const scope of ['session:', 'session-pins:', 'project:', 'recent-projects:', 'sidebar-projects:', 'session-groups-collapsed:', 'session-order:']) {
      const old = prefix + scope + from;
      if (key === old || key.startsWith(old + ':')) moves.push([key, prefix + scope + to + key.slice(old.length)]);
    }
  }
  return moves;
}

/**
 * 电脑端「终端配置」→ 新建会话选项。手机只拿到 id 与名称，命令由电脑端按 id 解析，
 * 用户文字不会进入启动命令。旧版电脑端不支持时返回 null，只保留普通终端（id 为 null）。
 */
export function terminalProfileChoices(list) {
  const choices = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : t('未命名配置');
    choices.push({ id: item.id, name, trusted: item.trusted !== false });
  }
  return choices.length ? choices : [{ id: null, name: t('新建终端'), trusted: true }];
}

/**
 * 时长文案：不足 1 分钟、N 分钟、N 小时（10 小时内带分钟）。
 * 已经过的时长向下取整，剩余时长（`ceil`）向上取整，刚活动时显示「24 小时后」而不是 23 小时。
 */
export function formatDuration(ms, ceil = false) {
  const round = ceil ? Math.ceil : Math.floor;
  const minutes = Math.max(0, round(ms / 60000));
  if (minutes < 1) return t('不到 1 分钟');
  if (minutes < 60) return t('{n} 分钟', { n: minutes });
  const rest = minutes % 60;
  const hours = Math.floor(minutes / 60);
  if (hours < 10 && rest) return t('{h} 小时 {m} 分', { h: hours, m: rest });
  return t('{h} 小时', { h: ceil && rest ? hours + 1 : hours });
}

/**
 * 会话创建时间：当天只显示「HH:mm」，同年为「MM-DD HH:mm」，跨年带年份。
 * 没有 `createdAt`（旧版电脑端）时返回空字符串。
 */
export function createdLabel(item, now = Date.now()) {
  const at = item?.createdAt;
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  const today = new Date(now);
  const pad = value => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const text = date.toDateString() === today.toDateString() ? time
    : date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
  return t('创建于 {time}', { time: text });
}

/**
 * 手机终端的空闲与自动结束提示（24 小时无输入也无输出时由电脑端结束）。
 * 没有 `idleDeadline`（已结束或旧版电脑端）时返回空字符串。
 */
export function idleLabel(item, now = Date.now(), action = t('自动结束')) {
  if (!Number.isFinite(item?.idleDeadline)) return '';
  const idle = Number.isFinite(item.lastActiveAt) ? now - item.lastActiveAt : null;
  const left = idleRemaining(item, now);
  const head = idleHead(idle);
  const tail = left <= 0 ? t('即将{action}', { action }) : t('{time}后{action}', { time: formatDuration(left, true), action });
  return [head, tail].filter(Boolean).join(t('，'));
}

function idleHead(idle) {
  if (idle === null) return '';
  return idle < 60000 ? t('刚刚有活动') : t('空闲 {time}', { time: formatDuration(idle) });
}

function idleRemaining(item, now) {
  // 截止时间来自电脑端时钟：手机时钟偏慢时差值会超过整个空闲窗口，向上取整后显示成 25 小时，这里封顶。
  return Number.isFinite(item.lastActiveAt)
    ? Math.min(item.idleDeadline - now, item.idleDeadline - item.lastActiveAt)
    : item.idleDeadline - now;
}

const IDLE_WARNING_MS = 2 * 60 * 60 * 1000;

/**
 * 会话行的空闲信息：平时只说空闲多久，距自动结束不足 2 小时才带上倒计时并标记 expiring。
 * 已结束或旧版电脑端没有 `idleDeadline` 时 text 为空。
 */
export function sessionIdleInfo(item, now = Date.now()) {
  if (item?.exit || !Number.isFinite(item?.idleDeadline)) return { text: '', expiring: false };
  if (idleRemaining(item, now) <= IDLE_WARNING_MS) return { text: idleLabel(item, now), expiring: true };
  return { text: idleHead(Number.isFinite(item.lastActiveAt) ? now - item.lastActiveAt : null), expiring: false };
}
