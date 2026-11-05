// 聊天式 Agent 的纯逻辑：条目合并、Markdown 解析、状态与额度文案。不访问 DOM，便于单元测试。

export const PROVIDERS = {
  claude: { name: 'Claude', letter: 'C', hue: 2 },
  codex: { name: 'Codex', letter: 'X', hue: 1 },
  opencode: { name: 'OpenCode', letter: 'O', hue: 0 },
};

/** 能否开启对话：本机、WSL 与 Linux / macOS 远端；Windows 远端（ConPTY）暂只支持终端。 */
export function chatSupported(project) {
  if (!project || project.kind !== 'ssh') return !!project;
  return !/^ssh:\/\/[^/]+\/+[A-Za-z]:(?:[\\/]|$)/.test(project.path ?? '');
}

export function providerInfo(id) {
  return PROVIDERS[id] ?? { name: id || 'Agent', letter: '?', hue: 5 };
}

/**
 * 合并增量条目：同 id 替换，新 id 追加；`full` 时以服务端窗口为准，
 * 但保留窗口之前已加载的更早条目，避免回看历史时被清空。
 */
export function mergeItems(current, incoming, full) {
  if (full) {
    const ids = new Set(incoming.map(item => item.id));
    const first = incoming[0]?.id;
    const firstIndex = first === undefined ? -1 : current.findIndex(item => item.id === first);
    const older = firstIndex > 0 ? current.slice(0, firstIndex).filter(item => !ids.has(item.id)) : [];
    return [...older, ...incoming];
  }
  if (!incoming.length) return current;
  const next = current.slice();
  const index = new Map(next.map((item, position) => [item.id, position]));
  for (const item of incoming) {
    const position = index.get(item.id);
    if (position === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[position] = item;
    }
  }
  return next;
}

/** 历史分页：把更早的条目放在前面，去掉重复。 */
export function prependItems(current, older) {
  const ids = new Set(current.map(item => item.id));
  return [...older.filter(item => !ids.has(item.id)), ...current];
}

export function threadTitle(thread) {
  return thread?.title?.trim() || '新对话';
}

export function threadStatus(thread) {
  if (!thread) return { label: '', tone: 'muted' };
  if (thread.pending > 0) return { label: `等待审批 ${thread.pending}`, tone: 'warn' };
  switch (thread.status) {
    case 'starting': return { label: '启动中', tone: 'busy' };
    case 'running': return { label: '执行中', tone: 'busy' };
    case 'error': return { label: '出错', tone: 'error' };
    case 'idle': return { label: '就绪', tone: 'ok' };
    default: return { label: '已暂停', tone: 'muted' };
  }
}

/**
 * 时长文案：不足 1 分钟、N 分钟、N 小时（10 小时内带分钟）。
 * 已经过的时长向下取整，剩余时长（`ceil`）向上取整，刚活动时显示「24 小时后」而不是 23 小时。
 */
export function formatDuration(ms, ceil = false) {
  const round = ceil ? Math.ceil : Math.floor;
  const minutes = Math.max(0, round(ms / 60000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const rest = minutes % 60;
  const hours = Math.floor(minutes / 60);
  if (hours < 10 && rest) return `${hours} 小时 ${rest} 分`;
  return `${ceil && rest ? hours + 1 : hours} 小时`;
}

/**
 * 空闲与自动结束提示（手机终端与对话的 Agent 进程，24 小时无输入也无输出时结束）。
 * 没有 `idleDeadline`（已结束、已暂停或旧版电脑端）时返回空字符串。
 */
export function idleLabel(item, now = Date.now(), action = '自动结束') {
  if (!Number.isFinite(item?.idleDeadline)) return '';
  const left = item.idleDeadline - now;
  const idle = Number.isFinite(item.lastActiveAt) ? now - item.lastActiveAt : null;
  const head = idle === null ? '' : idle < 60000 ? '刚刚有活动' : `空闲 ${formatDuration(idle)}`;
  const tail = left <= 0 ? `即将${action}` : `${formatDuration(left, true)}后${action}`;
  return [head, tail].filter(Boolean).join('，');
}

export function relativeTime(time, now = Date.now()) {
  if (!time) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatTokens(value) {
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return (value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** 对话内用量：上下文占用与花费。 */
export function usageSummary(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const parts = [];
  const used = usage.contextUsed;
  const size = usage.contextWindow;
  if (Number.isFinite(used) && Number.isFinite(size) && size > 0) {
    parts.push(`上下文 ${Math.min(100, Math.round(used / size * 100))}%`);
  } else if (Number.isFinite(used)) {
    parts.push(`上下文 ${formatTokens(used)}`);
  }
  const cost = usage.cost;
  if (cost && Number.isFinite(cost.amount) && cost.amount > 0) {
    parts.push((cost.currency === 'USD' || !cost.currency ? '$' : cost.currency + ' ') + cost.amount.toFixed(cost.amount < 1 ? 3 : 2));
  }
  return parts.join(' · ');
}

/** 额度重置时间：Codex 为 Unix 秒，Claude 为 ISO 字符串。 */
export function resetTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function resetLabel(value, now = Date.now()) {
  const time = resetTime(value);
  if (time === null) return '';
  const minutes = Math.round((time - now) / 60000);
  if (minutes <= 0) return '即将重置';
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后重置`;
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 重置`;
}

export function quotaWindows(quota, now = Date.now()) {
  return (quota?.windows ?? [])
    .filter(window => Number.isFinite(window?.percent))
    .map(window => ({
      label: window.label || '额度',
      percent: Math.max(0, Math.min(100, Math.round(window.percent))),
      reset: resetLabel(window.resetsAt, now),
      tone: window.percent >= 90 ? 'error' : window.percent >= 70 ? 'warn' : 'ok',
    }));
}

/** 选择面板的搜索：空格分隔多个关键词，全部命中（标题 / 说明 / 附加信息，不区分大小写）才保留。 */
export function filterChoices(choices, query) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return choices;
  return choices.filter(choice => {
    const text = [choice.label, choice.detail, choice.hint].filter(Boolean).join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export const RECENT_CHAT_PROJECT_LIMIT = 5;

/** 记录最近用于对话的项目（最新在前、去重、限量）。 */
export function rememberChatProject(recent, id, limit = RECENT_CHAT_PROJECT_LIMIT) {
  if (!id) return recent ?? [];
  return [id, ...(recent ?? []).filter(item => item !== id)].slice(0, limit);
}

export function parseRecentChatProjects(raw) {
  try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, RECENT_CHAT_PROJECT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function safetyOption(catalog, provider, safety) {
  const entry = catalog?.find?.(item => item.id === provider);
  return entry?.safety?.find(option => option.id === safety) ?? null;
}

const TOOL_VERBS = {
  command: '运行',
  edit: '修改',
  read: '读取',
  search: '搜索',
  web: '联网',
  mcp: '工具',
  agent: '子代理',
  other: '工具',
};

export function toolVerb(category) {
  return TOOL_VERBS[category] ?? TOOL_VERBS.other;
}

export function toolStatusLabel(status) {
  return { running: '进行中', done: '完成', failed: '失败', declined: '已拒绝', stopped: '已停止' }[status] ?? '';
}

export function approvalChoiceLabel(approval) {
  const option = approval?.options?.find(item => item.id === approval.choice);
  if (option) return option.label;
  return { cancelled: '已取消', expired: '已失效' }[approval?.choice ?? approval?.state] ?? '已处理';
}

export function diffLineKind(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

// ---------- Markdown（子集：标题、列表、引用、代码块、行内代码、粗体、斜体、链接、分隔线、表格按原文） ----------

export function markdownBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const code = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) code.push(lines[index++]);
      blocks.push({ type: 'code', lang: fence[2] || '', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, '') });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      if (list || (paragraph.length && blocks.at(-1)?.type !== 'quote')) flush();
      const last = blocks.at(-1);
      if (last?.type === 'quote' && !paragraph.length) last.text += '\n' + quote[1];
      else blocks.push({ type: 'quote', text: quote[1] });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length) {
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
        paragraph = [];
      }
      const ordered = /\d/.test(item[2]);
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      if (!list || list.ordered !== ordered) {
        if (list) blocks.push(list);
        list = { type: 'list', ordered, start: ordered ? parseInt(item[2], 10) : 1, items: [] };
      }
      list.items.push({
        text: task ? task[2] : item[3],
        depth: Math.min(3, Math.floor(item[1].replace(/\t/g, '  ').length / 2)),
        checked: task ? task[1] !== ' ' : null,
      });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items.at(-1).text += '\n' + line.trim();
      continue;
    }
    if (list) {
      blocks.push(list);
      list = null;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** 行内标记：`code`、**粗体**、*斜体*、[文字](链接)、裸链接。 */
export function inlineTokens(text) {
  const tokens = [];
  const source = String(text ?? '');
  const pattern = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"，。；：！？])/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) tokens.push({ type: 'text', text: source.slice(last, match.index) });
    if (match[2] !== undefined) tokens.push({ type: 'code', text: match[2] });
    else if (match[3] !== undefined || match[4] !== undefined) tokens.push({ type: 'bold', text: match[3] ?? match[4] });
    else if (match[5] !== undefined) tokens.push({ type: 'italic', text: match[5] });
    else if (match[6] !== undefined) {
      tokens.push(SAFE_LINK.test(match[7])
        ? { type: 'link', text: match[6], href: match[7] }
        : { type: 'text', text: match[6] });
    } else tokens.push({ type: 'link', text: match[8], href: match[8] });
    last = match.index + match[0].length;
  }
  if (last < source.length) tokens.push({ type: 'text', text: source.slice(last) });
  return tokens;
}

/** 提问卡片的回答：每题选中的选项与自定义文字。 */
export function collectAnswers(questions, selections, others) {
  const answers = {};
  for (const question of questions ?? []) {
    const id = String(question.id ?? question.question ?? '');
    const picked = [...(selections.get(id) ?? [])];
    const other = (others.get(id) ?? '').trim();
    if (other) picked.push(other);
    if (picked.length) answers[id] = picked;
  }
  return answers;
}

/** 列表排序：待审批 > 执行中 > 最近更新。 */
export function sortThreads(threads) {
  const weight = thread => (thread.pending > 0 ? 2 : thread.status === 'running' || thread.status === 'starting' ? 1 : 0);
  return [...threads].sort((a, b) => weight(b) - weight(a) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
