// 聊天式 Agent 界面：对话列表、对话页（消息流、工具卡片、审批）、新建与设置弹层、额度。
// 电脑端协议见 src-tauri/src/agent/；纯逻辑在 chatModel.js。
import {
  approvalChoiceLabel,
  chatSupported,
  idleLabel,
  collectAnswers,
  diffLineKind,
  filterChoices,
  inlineTokens,
  markdownBlocks,
  mergeItems,
  parseRecentChatProjects,
  prependItems,
  providerInfo,
  quotaWindows,
  relativeTime,
  rememberChatProject,
  safetyOption,
  sortThreads,
  threadStatus,
  threadTitle,
  toolStatusLabel,
  toolVerb,
  usageSummary,
} from './chatModel.js';
import { projectSourceLabel } from './protocol.js';

const get = id => document.getElementById(id);
const prefix = 'qingcode:mobile:';
const LIST_REFRESH_MS = 5000;
const CATEGORY_ICONS = { command: 'terminal', edit: 'edit', read: 'folder', search: 'search', web: 'host', mcp: 'spark', agent: 'spark', other: 'spark' };

function icon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.append(use);
  return svg;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function providerAvatar(provider, small = false) {
  const info = providerInfo(provider);
  const node = element('span', 'avatar provider-avatar' + (small ? ' small' : ''), info.letter);
  node.dataset.hue = String(info.hue);
  node.dataset.provider = provider;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const PICKER_SEARCH_MIN = 7;

/**
 * 贴底选择面板，替代系统原生下拉：选项多时可搜索，可分组，当前值打勾。
 * choices: [{ id, label, detail?, hint?, group?, kind? }]；返回所选 id，取消返回 null。
 */
function pick({ title, choices, value = null, placeholder = '搜索', searchable } = {}) {
  const dialog = get('picker-dialog');
  const list = get('picker-list');
  const search = get('picker-search');
  const canSearch = searchable ?? choices.length >= PICKER_SEARCH_MIN;
  get('picker-title').textContent = title;
  get('picker-search-field').hidden = !canSearch;
  dialog.dataset.search = String(canSearch);
  search.value = '';
  search.placeholder = placeholder;
  search.setAttribute('aria-label', placeholder);
  let chosen = null;

  const render = () => {
    const query = search.value;
    const matching = filterChoices(choices, query);
    const nodes = [];
    let group;
    for (const choice of matching) {
      // 搜索时不分组，结果平铺更易扫读。
      if (!query.trim() && choice.group && choice.group !== group) {
        group = choice.group;
        nodes.push(element('p', 'picker-group', group));
      }
      const row = element('button', 'picker-option');
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(choice.id === value));
      row.dataset.id = choice.id;
      if (choice.kind) row.dataset.kind = choice.kind;
      const text = element('span', 'picker-option-text');
      text.append(element('strong', '', choice.label));
      if (choice.detail) text.append(element('small', '', choice.detail));
      if (choice.hint) text.append(element('small', 'picker-option-hint', choice.hint));
      row.append(text);
      if (choice.id === value) row.append(icon('check', 'picker-check'));
      row.addEventListener('click', () => {
        chosen = choice.id;
        dialog.close('confirm');
      });
      nodes.push(row);
    }
    list.replaceChildren(...nodes);
    get('picker-empty').hidden = matching.length > 0;
  };

  search.oninput = render;
  search.onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = filterChoices(choices, search.value)[0];
    if (first) {
      chosen = first.id;
      dialog.close('confirm');
    }
  };
  render();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      search.oninput = null;
      search.onkeydown = null;
      resolve(chosen);
    }, { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
    // showModal 会聚焦第一个可聚焦元素（搜索框）并顶起键盘；点选更常用，需要时再点搜索框。
    if (document.activeElement === search) search.blur();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
  });
}

/**
 * @param {object} deps
 * @param {(op: string, args?: object) => Promise<any>} deps.remote 当前电脑的 RPC
 * @param {(op: string, args?: object) => Promise<any>} deps.rpc 原生桥（剪贴板、选图、链接）
 * @param {() => any} deps.profile 当前连接
 * @param {() => any[]} deps.projects 已信任项目
 * @param {() => boolean} deps.online
 * @param {(project: any) => void} deps.openTerminal
 * @param {(page: string) => void} deps.showPage
 * @param {() => void} deps.connect 未连接时的处理（配对、重连）
 * @param {() => boolean} deps.hasProfiles
 * @param {(title: string, text: string, action: string) => Promise<boolean>} deps.confirm
 * @param {(error: any) => void} deps.onRevoked
 */
export function createChat(deps) {
  const screen = get('chat-thread');
  const list = get('chat-list');
  const itemsBox = get('chat-items');
  const scroller = get('chat-scroll');
  const input = get('chat-input');
  let catalog = null;
  let catalogProfile = null;
  let threads = [];
  let listTimer = null;
  let listEpoch = 0;
  let listVisible = false;
  let foreground = true;
  let current = null;
  let items = [];
  let rev = 0;
  let threadEpoch = 0;
  let rendered = new Map();
  let attachments = [];
  let uploading = false;
  let sending = false;
  let hasOlder = false;
  let newDraft = { provider: null, project: null, safety: null };
  let projectSheetTarget = null;
  const selections = new Map();
  const others = new Map();

  const draftKey = id => prefix + 'chat-draft:' + (deps.profile()?.id ?? '') + ':' + id;
  const lastProviderKey = () => prefix + 'chat-provider:' + (deps.profile()?.id ?? '');
  const lastProjectKey = () => prefix + 'chat-project:' + (deps.profile()?.id ?? '');
  const recentProjectsKey = () => prefix + 'chat-projects:' + (deps.profile()?.id ?? '');

  function chatProjects() {
    return deps.projects().filter(chatSupported);
  }

  function outdated(error) {
    return /请求格式无效|未知操作/.test(error?.message ?? '');
  }

  function explain(error) {
    if (outdated(error)) return '电脑端 QingCode 版本较旧，不支持对话模式，请更新电脑端后重试。';
    return error?.message ?? String(error);
  }

  function showError(id, error) {
    const target = get(id);
    const text = error ? explain(error) : '';
    target.textContent = text;
    target.hidden = !text;
  }

  async function loadCatalog(force = false) {
    const profile = deps.profile();
    if (!profile || !deps.online()) return null;
    if (catalog && catalogProfile === profile.id && !force) return catalog;
    catalog = await deps.remote('agent_catalog');
    catalogProfile = profile.id;
    return catalog;
  }

  // ---------- 对话列表 ----------

  function threadRow(thread) {
    const row = element('button', 'row chat-row');
    row.type = 'button';
    row.addEventListener('click', () => { void openThread(thread.id); });
    const status = threadStatus(thread);
    const text = element('span', 'row-text');
    const title = element('strong', '', threadTitle(thread));
    const meta = element('small', 'chat-row-meta', providerInfo(thread.provider).name + ' · ' + thread.projectName + ' · ' + relativeTime(thread.updatedAt));
    const preview = element('small', 'chat-row-preview', thread.error || thread.preview || '还没有消息');
    text.append(title, meta, preview);
    const badge = element('span', 'status-chip', status.label);
    badge.dataset.tone = status.tone;
    row.append(providerAvatar(thread.provider), text, badge);
    return row;
  }

  function renderList() {
    const profile = deps.profile();
    const online = !!profile && deps.online();
    const sorted = sortThreads(threads);
    list.replaceChildren(...sorted.map(threadRow));
    get('chat-new').disabled = !online;
    get('chat-settings').disabled = !online;
    get('chat-subtitle').textContent = profile ? profile.name + ' · Claude / Codex / OpenCode' : '用 Claude、Codex、OpenCode 远程写代码。';
    const empty = !sorted.length;
    get('chat-empty').hidden = !empty;
    get('chat-empty-title').textContent = !profile ? '先连接一台电脑' : !online ? '电脑暂时不可达' : '开始一段对话';
    get('chat-empty-text').textContent = !profile
      ? '配对电脑后，就能用手机和电脑上的 Claude、Codex、OpenCode 对话。'
      : !online ? '检查手机和电脑的网络后重试。'
        : '选择项目和 Agent，像聊天一样描述需求；编辑、命令等操作按安全选项在手机上确认。';
    get('chat-empty-action').textContent = !profile ? (deps.hasProfiles?.() ? '查看连接' : '添加连接') : !online ? '重新连接' : '新对话';
    get('chat-terminals').hidden = !profile;
    get('chat-list-heading').hidden = empty;
  }

  async function refreshList() {
    const epoch = ++listEpoch;
    if (!deps.profile() || !deps.online()) {
      threads = [];
      renderList();
      return;
    }
    try {
      const result = await deps.remote('agent_threads');
      if (epoch !== listEpoch) return;
      threads = result;
      showError('chat-error', null);
    } catch (error) {
      if (epoch !== listEpoch) return;
      if (error.revoked) deps.onRevoked(error);
      showError('chat-error', error);
    }
    renderList();
  }

  function scheduleList() {
    clearTimeout(listTimer);
    if (!listVisible || !foreground) return;
    listTimer = setTimeout(async () => {
      await refreshList();
      scheduleList();
    }, LIST_REFRESH_MS);
  }

  function renderQuotaStrip(quotas) {
    const strip = get('chat-quota');
    strip.replaceChildren();
    for (const quota of quotas ?? []) {
      const windows = quotaWindows(quota);
      const cell = element('span', 'quota-cell');
      cell.append(element('strong', '', quota.name));
      if (windows.length) {
        const top = windows.reduce((a, b) => (b.percent > a.percent ? b : a));
        const bar = element('span', 'quota-bar');
        const fill = element('span');
        fill.style.width = top.percent + '%';
        bar.dataset.tone = top.tone;
        bar.append(fill);
        cell.append(bar, element('small', '', top.label + ' ' + top.percent + '%'));
      } else {
        cell.append(element('small', '', quota.error ? '不可用' : quota.provider === 'opencode' ? '按提供方' : '点按查看'));
      }
      strip.append(cell);
    }
    strip.hidden = !(quotas ?? []).length;
  }

  async function loadQuotaStrip() {
    if (!deps.profile() || !deps.online()) {
      get('chat-quota').hidden = true;
      return;
    }
    try {
      renderQuotaStrip(await deps.remote('agent_usage', { refresh: false }));
    } catch {
      get('chat-quota').hidden = true;
    }
  }

  function setListVisible(visible) {
    listVisible = visible;
    if (visible) {
      renderList();
      void refreshList();
      void loadQuotaStrip();
      scheduleList();
    } else {
      clearTimeout(listTimer);
    }
  }

  // ---------- 渲染条目 ----------

  function inline(parent, text) {
    for (const token of inlineTokens(text)) {
      if (token.type === 'text') parent.append(document.createTextNode(token.text));
      else if (token.type === 'code') parent.append(element('code', '', token.text));
      else if (token.type === 'bold') parent.append(element('strong', '', token.text));
      else if (token.type === 'italic') parent.append(element('em', '', token.text));
      else {
        const link = element('a', '', token.text);
        link.href = token.href;
        link.addEventListener('click', event => {
          event.preventDefault();
          void deps.rpc('open_link', { url: token.href }).catch(() => {});
        });
        parent.append(link);
      }
    }
  }

  function inlineLines(parent, text) {
    String(text).split('\n').forEach((line, index) => {
      if (index) parent.append(document.createElement('br'));
      inline(parent, line);
    });
  }

  function codeBlock(text, lang) {
    const wrap = element('div', 'code-block');
    const head = element('div', 'code-head');
    head.append(element('span', '', lang || '代码'));
    const copy = element('button', 'text-button', '复制');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await deps.rpc('copy', { text });
        copy.textContent = '已复制';
        setTimeout(() => { copy.textContent = '复制'; }, 1500);
      } catch { /* 剪贴板不可用时保持原文案 */ }
    });
    head.append(copy);
    const pre = element('pre');
    pre.append(element('code', '', text));
    wrap.append(head, pre);
    return wrap;
  }

  function markdown(text) {
    const box = element('div', 'markdown');
    for (const block of markdownBlocks(text)) {
      if (block.type === 'paragraph') {
        const p = element('p');
        inlineLines(p, block.text);
        box.append(p);
      } else if (block.type === 'heading') {
        const heading = element('h' + Math.min(6, block.level + 2));
        inline(heading, block.text);
        box.append(heading);
      } else if (block.type === 'code') box.append(codeBlock(block.text, block.lang));
      else if (block.type === 'quote') {
        const quote = element('blockquote');
        inlineLines(quote, block.text);
        box.append(quote);
      } else if (block.type === 'rule') box.append(element('hr'));
      else if (block.type === 'list') {
        const listNode = element(block.ordered ? 'ol' : 'ul');
        if (block.ordered && block.start !== 1) listNode.start = block.start;
        for (const entry of block.items) {
          const li = element('li');
          li.dataset.depth = String(entry.depth);
          if (entry.checked !== null) {
            li.dataset.task = entry.checked ? 'done' : 'todo';
            li.append(element('span', 'task-mark', entry.checked ? '☑' : '☐'));
          }
          inlineLines(li, entry.text);
          listNode.append(li);
        }
        box.append(listNode);
      }
    }
    return box;
  }

  function diffView(files) {
    const box = element('div', 'diff-files');
    for (const file of files ?? []) {
      const block = element('div', 'diff-file');
      block.append(element('div', 'diff-path', (file.change === 'add' ? '新增 ' : file.change === 'delete' ? '删除 ' : '') + (file.path ?? '')));
      if (file.diff) {
        const pre = element('pre', 'diff');
        for (const line of String(file.diff).replace(/\n$/, '').split('\n')) {
          const span = element('span', 'diff-line', line || ' ');
          span.dataset.kind = diffLineKind(line);
          pre.append(span);
        }
        block.append(pre);
      }
      box.append(block);
    }
    return box;
  }

  function renderTool(item) {
    const tool = item.tool ?? {};
    const node = element('details', 'chat-tool');
    node.dataset.status = tool.status ?? 'running';
    node.dataset.category = tool.category ?? 'other';
    const summary = element('summary');
    summary.append(icon(CATEGORY_ICONS[tool.category] ?? 'spark'));
    summary.append(element('span', 'tool-verb', toolVerb(tool.category)));
    summary.append(element('span', 'tool-title', tool.title || tool.name || ''));
    const status = element('span', 'tool-status', toolStatusLabel(tool.status));
    summary.append(status);
    node.append(summary);
    const body = element('div', 'tool-body');
    if (tool.detail) body.append(element('p', 'tool-detail', tool.detail));
    if (tool.files?.length) body.append(diffView(tool.files));
    if (tool.output) body.append(element('pre', 'tool-output', tool.output));
    if (Number.isFinite(tool.exitCode) && tool.exitCode !== 0) body.append(element('p', 'tool-detail', '退出码 ' + tool.exitCode));
    if (!body.childNodes.length) body.append(element('p', 'tool-detail', '没有输出'));
    node.append(body);
    return node;
  }

  function renderPlan(item) {
    const node = element('div', 'chat-plan');
    node.append(element('strong', '', '计划'));
    if (item.explanation) node.append(element('p', '', item.explanation));
    const listNode = element('ol');
    for (const step of item.steps ?? []) {
      const li = element('li', '', step.text ?? '');
      li.dataset.status = step.status ?? 'pending';
      listNode.append(li);
    }
    node.append(listNode);
    return node;
  }

  function questionForm(item, approval) {
    const form = element('div', 'question-form');
    for (const question of approval.questions ?? []) {
      const id = String(question.id ?? question.question ?? '');
      const field = element('fieldset', 'question');
      if (question.header) field.append(element('legend', '', question.header));
      field.append(element('p', '', question.question ?? ''));
      const chosen = selections.get(item.id + '\u0000' + id) ?? new Set();
      selections.set(item.id + '\u0000' + id, chosen);
      for (const option of question.options ?? []) {
        const label = element('label', 'question-option');
        const box = element('input');
        box.type = question.multiple ? 'checkbox' : 'radio';
        box.name = item.id + ':' + id;
        box.checked = chosen.has(option.label);
        box.addEventListener('change', () => {
          if (!question.multiple) chosen.clear();
          if (box.checked) chosen.add(option.label);
          else chosen.delete(option.label);
        });
        const text = element('span');
        text.append(element('strong', '', option.label ?? ''));
        if (option.description) text.append(element('small', '', option.description));
        label.append(box, text);
        field.append(label);
      }
      if (question.other !== false) {
        const other = element('input', 'question-other');
        other.placeholder = question.options?.length ? '其他（可选）' : '输入回答';
        other.value = others.get(item.id + '\u0000' + id) ?? '';
        other.addEventListener('input', () => others.set(item.id + '\u0000' + id, other.value));
        field.append(other);
      }
      form.append(field);
    }
    return form;
  }

  function answersFor(item, approval) {
    const scopedSelections = new Map();
    const scopedOthers = new Map();
    for (const question of approval.questions ?? []) {
      const id = String(question.id ?? question.question ?? '');
      scopedSelections.set(id, selections.get(item.id + '\u0000' + id) ?? new Set());
      scopedOthers.set(id, others.get(item.id + '\u0000' + id) ?? '');
    }
    return collectAnswers(approval.questions, scopedSelections, scopedOthers);
  }

  function renderApproval(item) {
    const approval = item.approval ?? {};
    const node = element('div', 'chat-approval');
    node.dataset.state = approval.state ?? 'pending';
    node.dataset.type = approval.type ?? 'tool';
    const label = { command: '运行命令', edit: '修改文件', permission: '申请权限', question: '需要回答', plan: '批准计划' }[approval.type] ?? '请求许可';
    const head = element('div', 'approval-head');
    head.append(icon(approval.type === 'question' ? 'chat' : 'shield'), element('span', '', label));
    node.append(head);
    if (approval.title && approval.type !== 'question') node.append(element('p', 'approval-title', approval.title));
    if (approval.detail) {
      if (approval.type === 'plan') node.append(markdown(approval.detail));
      else node.append(element('pre', 'approval-detail', approval.detail));
    }
    // 处理后改动由对应的工具卡片展示，审批卡片只保留结论。
    if (item.files?.length && approval.state === 'pending') node.append(diffView(item.files));
    if (approval.state !== 'pending') {
      node.append(element('p', 'approval-result', approvalChoiceLabel(approval)));
      return node;
    }
    if (approval.type === 'question') node.append(questionForm(item, approval));
    const actions = element('div', 'approval-actions');
    for (const option of approval.options ?? []) {
      const button = element('button', option.tone === 'primary' ? 'primary' : option.tone === 'danger' ? 'secondary danger' : 'secondary', option.label);
      button.type = 'button';
      button.addEventListener('click', () => { void respond(item, option.id, button); });
      actions.append(button);
    }
    node.append(actions);
    node.append(element('p', 'error approval-error'));
    node.lastChild.hidden = true;
    return node;
  }

  function renderItem(item) {
    let node;
    switch (item.kind) {
      case 'user': {
        node = element('div', 'chat-message user');
        const bubble = element('div', 'bubble');
        inlineLines(bubble, item.text ?? '');
        if (item.images) bubble.append(element('small', 'bubble-note', `已附 ${item.images} 张图片`));
        node.append(bubble);
        break;
      }
      case 'assistant':
        node = element('div', 'chat-message assistant');
        if (item.proposal) node.append(element('small', 'bubble-note', '方案'));
        node.append(markdown(item.text ?? ''));
        if (item.streaming) node.classList.add('streaming');
        break;
      case 'reasoning': {
        node = element('details', 'chat-reasoning');
        const summary = element('summary', '', item.streaming ? '正在思考…' : '思考过程');
        node.append(summary, element('div', 'reasoning-text', item.text ?? ''));
        break;
      }
      case 'tool':
        node = renderTool(item);
        break;
      case 'plan':
        node = renderPlan(item);
        break;
      case 'approval':
        node = renderApproval(item);
        break;
      default:
        node = element('p', 'chat-notice', item.text ?? '');
        node.dataset.level = item.level ?? 'info';
    }
    node.dataset.id = item.id;
    return node;
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  }

  function scrollToBottom() {
    scroller.scrollTop = scroller.scrollHeight;
    get('chat-bottom').hidden = true;
  }

  function renderItems({ stick = nearBottom() } = {}) {
    const next = new Map();
    const nodes = [];
    for (const item of items) {
      const previous = rendered.get(item.id);
      if (previous && previous.rev === item.rev) {
        next.set(item.id, previous);
        nodes.push(previous.node);
        continue;
      }
      const node = renderItem(item);
      if (previous?.node.open) node.open = true;
      next.set(item.id, { rev: item.rev, node });
      nodes.push(node);
    }
    rendered = next;
    itemsBox.replaceChildren(...nodes);
    get('chat-older').hidden = !hasOlder;
    const running = current && (current.status === 'running' || current.status === 'starting') && current.pending === 0;
    const streaming = items.some(item => item.streaming);
    get('chat-typing').hidden = !running || streaming;
    if (stick) scrollToBottom();
  }

  // ---------- 对话页 ----------

  function renderHeader() {
    if (!current) return;
    const info = providerInfo(current.provider);
    get('chat-thread-title').textContent = threadTitle(current);
    const status = threadStatus(current);
    get('chat-thread-sub').textContent = info.name + ' · ' + current.projectName + (status.label ? ' · ' + status.label : '');
    get('chat-thread-sub').dataset.tone = status.tone;
    get('chat-thread-avatar').replaceWith(Object.assign(providerAvatar(current.provider, true), { id: 'chat-thread-avatar' }));
    const option = safetyOption(catalog, current.provider, current.safety);
    get('chat-safety-label').textContent = option?.label ?? current.safety ?? '安全选项';
    get('chat-safety').dataset.full = String(!!option?.full);
    const model = current.options?.models?.find?.(entry => entry.id === current.model);
    get('chat-model-label').textContent = model?.label ?? current.model ?? '默认模型';
    get('chat-usage').textContent = usageSummary(current.usage);
    const running = current.status === 'running' || current.status === 'starting';
    const send = get('chat-send');
    send.dataset.mode = running ? 'stop' : 'send';
    send.setAttribute('aria-label', running ? '停止' : '发送');
    send.replaceChildren(icon(running ? 'stop' : 'send'));
    input.placeholder = current.pending > 0 ? '请先处理上方的请求…' : running ? 'Agent 正在执行…' : `给 ${info.name} 发消息…`;
    updateSendState();
  }

  function updateSendState() {
    const running = current && (current.status === 'running' || current.status === 'starting');
    const empty = !input.value.trim() && !attachments.length;
    get('chat-send').disabled = sending || uploading || (!running && (empty || current?.pending > 0));
    get('chat-attach').disabled = uploading || !!running;
  }

  function setState(text, tone = 'info') {
    const state = get('chat-state');
    state.textContent = text;
    state.dataset.tone = tone;
    state.hidden = !text;
  }

  function apply(result) {
    const stick = nearBottom();
    if (result.full && !items.length) hasOlder = (result.items?.length ?? 0) >= 300;
    items = mergeItems(items, result.items ?? [], result.full);
    rev = result.rev;
    current = { ...current, ...result.thread };
    renderHeader();
    renderItems({ stick });
    if (!stick && result.items?.length) get('chat-bottom').hidden = false;
  }

  async function pollLoop(epoch) {
    let failures = 0;
    while (epoch === threadEpoch && foreground) {
      try {
        const result = await deps.remote('agent_poll', { id: current.id, from: rev });
        if (epoch !== threadEpoch) return;
        failures = 0;
        if (get('chat-state').dataset.tone === 'offline') setState('');
        apply(result);
      } catch (error) {
        if (epoch !== threadEpoch) return;
        if (error.revoked) {
          deps.onRevoked(error);
          return;
        }
        if (/对话不存在/.test(error.message)) {
          setState('对话已在其他设备删除。', 'error');
          return;
        }
        failures += 1;
        setState('连接中断，正在重试…', 'offline');
        await sleep(Math.min(5000, 700 * failures));
      }
    }
  }

  function startPolling() {
    const epoch = ++threadEpoch;
    void pollLoop(epoch);
  }

  async function openThread(id, meta = null) {
    const epoch = ++threadEpoch;
    try {
      await loadCatalog();
    } catch { /* 目录只影响标签显示 */ }
    if (epoch !== threadEpoch) return;
    current = meta ?? threads.find(thread => thread.id === id) ?? { id, provider: '', projectName: '', status: 'closed', pending: 0 };
    items = [];
    rev = 0;
    hasOlder = false;
    rendered = new Map();
    attachments = [];
    selections.clear();
    others.clear();
    renderAttachments();
    input.value = localStorage.getItem(draftKey(id)) ?? '';
    resizeInput();
    setState('');
    itemsBox.replaceChildren();
    get('dashboard').hidden = true;
    get('terminal-screen').hidden = true;
    screen.hidden = false;
    setListVisible(false);
    renderHeader();
    localStorage.setItem(prefix + 'chat-open:' + (deps.profile()?.id ?? ''), id);
    startPolling();
  }

  function closeThread({ show = true } = {}) {
    if (screen.hidden) return false;
    threadEpoch += 1;
    if (current) {
      localStorage.setItem(draftKey(current.id), input.value);
      // 用对话页的最新状态更新列表缓存，避免返回时先闪现旧标题。
      const latest = current;
      threads = threads.map(thread => (thread.id === latest.id ? { ...thread, ...latest } : thread));
    }
    localStorage.removeItem(prefix + 'chat-open:' + (deps.profile()?.id ?? ''));
    screen.hidden = true;
    current = null;
    if (show) deps.showPage('chat');
    return true;
  }

  async function respond(item, choice, button) {
    if (!current) return;
    const approval = item.approval ?? {};
    const answers = approval.type === 'question' && choice === 'answer' ? answersFor(item, approval) : null;
    if (approval.type === 'question' && choice === 'answer' && !Object.keys(answers).length) {
      const error = rendered.get(item.id)?.node.querySelector('.approval-error');
      if (error) {
        error.textContent = '请至少选择或填写一个回答。';
        error.hidden = false;
      }
      return;
    }
    for (const other of rendered.get(item.id)?.node.querySelectorAll('.approval-actions button') ?? []) other.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await deps.remote('agent_respond', { id: current.id, approval: item.id, choice, answers });
    } catch (error) {
      const target = rendered.get(item.id)?.node.querySelector('.approval-error');
      if (target) {
        target.textContent = explain(error);
        target.hidden = false;
      }
      for (const other of rendered.get(item.id)?.node.querySelectorAll('.approval-actions button') ?? []) other.disabled = false;
    } finally {
      button.removeAttribute('aria-busy');
    }
  }

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }

  function renderAttachments() {
    const box = get('chat-attachments');
    box.replaceChildren(...attachments.map((attachment, index) => {
      const chip = element('span', 'attachment-chip');
      chip.append(icon('image'), element('span', '', '图片 ' + (index + 1)));
      const remove = element('button', 'icon-button');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除图片 ' + (index + 1));
      remove.append(icon('x'));
      remove.addEventListener('click', () => {
        attachments.splice(index, 1);
        renderAttachments();
        updateSendState();
      });
      chip.append(remove);
      return chip;
    }));
    box.hidden = !attachments.length;
  }

  async function attachImages() {
    if (uploading || !current) return;
    const id = current.id;
    const epoch = threadEpoch;
    uploading = true;
    updateSendState();
    let selection;
    try {
      const compression = localStorage.getItem(prefix + 'image-compression') ?? 'medium';
      const picked = await deps.rpc('pick_image', { compression });
      selection = picked?.selection;
      if (!picked || epoch !== threadEpoch) return;
      const count = selection ? picked.count : 1;
      for (let index = 0; index < count; index++) {
        if (epoch !== threadEpoch || current?.id !== id) return;
        setState(count === 1 ? '图片上传中…' : `图片上传中… ${index + 1}/${count}`);
        const image = selection ? await deps.rpc('read_image', { selection, index }) : picked;
        const uploaded = await deps.remote('agent_image', { data: image.data });
        if (epoch !== threadEpoch) return;
        attachments.push(uploaded);
        renderAttachments();
      }
      setState('');
    } catch (error) {
      if (epoch === threadEpoch) setState('图片未能上传：' + explain(error), 'error');
    } finally {
      if (selection) void deps.rpc('release_images', { selection }).catch(() => {});
      uploading = false;
      updateSendState();
    }
  }

  async function submit() {
    if (!current || sending) return;
    const running = current.status === 'running' || current.status === 'starting';
    sending = true;
    updateSendState();
    try {
      if (running) {
        await deps.remote('agent_interrupt', { id: current.id });
        setState('已请求停止…');
        return;
      }
      const text = input.value;
      const images = attachments.map(attachment => attachment.id);
      if (!text.trim() && !images.length) return;
      setState(current.running ? '' : '正在启动 Agent…');
      const meta = await deps.remote('agent_send', { id: current.id, text, images });
      input.value = '';
      localStorage.removeItem(draftKey(current.id));
      attachments = [];
      renderAttachments();
      resizeInput();
      current = { ...current, ...meta };
      setState('');
      renderHeader();
      scrollToBottom();
    } catch (error) {
      if (error.revoked) deps.onRevoked(error);
      else setState(explain(error), 'error');
    } finally {
      sending = false;
      updateSendState();
    }
  }

  async function loadOlder() {
    if (!current || !items.length) return;
    const first = items[0].id;
    const height = scroller.scrollHeight;
    try {
      const result = await deps.remote('agent_history', { id: current.id, before: first });
      const older = result.items ?? [];
      hasOlder = older.length >= 100;
      items = prependItems(items, older);
      renderItems({ stick: false });
      scroller.scrollTop += scroller.scrollHeight - height;
    } catch (error) {
      setState(explain(error), 'error');
    }
  }

  // ---------- 新建对话 ----------

  function safetyChoices(container, provider, selected, name) {
    const entry = catalog?.find(item => item.id === provider);
    container.replaceChildren();
    const legend = element('legend', '', '安全选项');
    container.append(legend);
    for (const option of entry?.safety ?? []) {
      const label = element('label');
      const radio = element('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = option.id;
      radio.checked = option.id === selected;
      const text = element('span');
      text.append(element('strong', '', option.label + (option.full ? ' · 不再询问' : '')), element('small', '', option.description));
      label.dataset.full = String(!!option.full);
      label.append(radio, text);
      container.append(label);
    }
  }

  function projectChoices(projects) {
    const recent = recentChatProjects();
    const recentSet = new Set(recent);
    const byId = new Map(projects.map(project => [project.id, project]));
    const choice = (project, group) => ({
      id: project.id,
      label: project.name,
      detail: projectSourceLabel(project),
      hint: project.kind === 'ssh' ? project.path.replace(/^ssh:\/\/[^/]+/, '') : project.path,
      kind: project.kind,
      group,
    });
    const recentChoices = recent.map(id => byId.get(id)).filter(Boolean).map(project => choice(project, '最近使用'));
    const rest = projects.filter(project => !recentSet.has(project.id))
      .map(project => choice(project, recentChoices.length ? '全部项目' : undefined));
    return [...recentChoices, ...rest];
  }

  function recentChatProjects() {
    const recent = parseRecentChatProjects(localStorage.getItem(recentProjectsKey()));
    // 兼容旧版本只记录了上次项目的情况。
    const last = localStorage.getItem(lastProjectKey());
    return last && !recent.includes(last) ? [last, ...recent] : recent;
  }

  function renderNewDialog() {
    const providers = get('chat-new-providers');
    providers.replaceChildren();
    for (const entry of catalog ?? []) {
      const label = element('label', 'provider-choice');
      const radio = element('input');
      radio.type = 'radio';
      radio.name = 'chat-provider';
      radio.value = entry.id;
      radio.checked = entry.id === newDraft.provider;
      radio.addEventListener('change', () => {
        newDraft.provider = entry.id;
        newDraft.safety = catalog?.find(item => item.id === entry.id)?.defaultSafety ?? null;
        renderNewDialog();
      });
      label.append(radio, providerAvatar(entry.id), element('strong', '', entry.name));
      if (!entry.installed) label.append(element('small', '', '本机未检测到'));
      providers.append(label);
    }

    const options = chatProjects();
    if (!options.some(project => project.id === newDraft.project)) {
      newDraft.project = projectChoices(options)[0]?.id ?? null;
    }
    const project = options.find(item => item.id === newDraft.project);
    const field = get('chat-new-project');
    field.disabled = !options.length;
    field.dataset.kind = project?.kind ?? '';
    get('chat-new-project-name').textContent = project?.name ?? '选择项目';
    get('chat-new-project-source').textContent = project ? projectSourceLabel(project) : '';
    get('chat-new-no-project').hidden = options.length > 0;

    const entry = catalog?.find(item => item.id === newDraft.provider);
    const safetyList = entry?.safety ?? [];
    if (!safetyList.some(option => option.id === newDraft.safety)) newDraft.safety = entry?.defaultSafety ?? safetyList[0]?.id ?? null;
    const segments = get('chat-new-safety');
    segments.replaceChildren(...safetyList.map(option => {
      const segment = element('button', 'safety-segment', option.label);
      segment.type = 'button';
      segment.setAttribute('role', 'radio');
      segment.setAttribute('aria-checked', String(option.id === newDraft.safety));
      segment.dataset.full = String(!!option.full);
      segment.addEventListener('click', () => {
        newDraft.safety = option.id;
        renderNewDialog();
      });
      return segment;
    }));
    segments.dataset.count = String(safetyList.length);
    const chosen = safetyOption(catalog, newDraft.provider, newDraft.safety);
    get('chat-new-safety-desc').textContent = chosen?.description ?? '';
    get('chat-new-full').hidden = !chosen?.full;
    const isDefault = !!chosen && chosen.id === entry?.defaultSafety;
    get('chat-new-default').closest('label').hidden = isDefault;
    if (isDefault) get('chat-new-default').checked = false;
    get('chat-new-start').disabled = !newDraft.provider || !newDraft.project;
  }

  async function chooseNewProject() {
    const options = chatProjects();
    if (!options.length) return;
    const id = await pick({
      title: '选择项目',
      choices: projectChoices(options),
      value: newDraft.project,
      placeholder: '搜索项目名、路径或主机',
    });
    if (id) {
      newDraft.project = id;
      renderNewDialog();
    }
  }

  async function openNewDialog({ provider = null, project = null } = {}) {
    showError('chat-new-error', null);
    try {
      await loadCatalog();
    } catch (error) {
      showError('chat-error', error);
      return;
    }
    const chosenProvider = provider ?? localStorage.getItem(lastProviderKey()) ?? catalog?.find(entry => entry.installed)?.id ?? 'claude';
    newDraft = {
      provider: chosenProvider,
      project: project ?? recentChatProjects()[0] ?? null,
      safety: catalog?.find(entry => entry.id === chosenProvider)?.defaultSafety ?? null,
    };
    get('chat-new-default').checked = false;
    renderNewDialog();
    get('chat-new-dialog').showModal();
  }

  async function startNewThread() {
    const provider = newDraft.provider;
    const projectId = newDraft.project;
    const safety = newDraft.safety;
    if (!provider || !projectId) return;
    const start = get('chat-new-start');
    start.disabled = true;
    start.textContent = '正在启动…';
    showError('chat-new-error', null);
    try {
      if (get('chat-new-default').checked && safety) {
        catalog = await deps.remote('agent_defaults', { provider, safety });
      }
      const meta = await deps.remote('agent_create', { project: projectId, provider, safety });
      localStorage.setItem(lastProviderKey(), provider);
      localStorage.setItem(lastProjectKey(), projectId);
      localStorage.setItem(recentProjectsKey(), JSON.stringify(rememberChatProject(recentChatProjects(), projectId)));
      get('chat-new-dialog').close();
      threads = [meta, ...threads.filter(thread => thread.id !== meta.id)];
      await openThread(meta.id, meta);
      input.focus();
    } catch (error) {
      if (error.revoked) deps.onRevoked(error);
      showError('chat-new-error', error);
    } finally {
      start.disabled = false;
      start.textContent = '开始对话';
    }
  }

  // ---------- 对话设置 ----------

  // 选项值可能是字符串或 { id, label, description }；首项为「默认」（空值）。
  function valueChoices(values, currentValue, fallbackLabel) {
    const choices = [{ id: '', label: fallbackLabel }];
    for (const value of values ?? []) {
      const id = typeof value === 'string' ? value : value?.id;
      if (!id) continue;
      const label = typeof value === 'string' ? value : value.label ?? id;
      choices.push({ id, label, detail: typeof value === 'string' ? undefined : value.description ?? (label !== id ? id : undefined) });
    }
    if (currentValue && !choices.some(choice => choice.id === currentValue)) choices.push({ id: currentValue, label: currentValue });
    return choices;
  }

  function optionLists() {
    const options = current?.options ?? {};
    const model = options.models?.find?.(entry => entry.id === current?.model);
    return {
      model: { title: '模型', values: options.models, fallback: '默认模型', placeholder: '搜索模型' },
      effort: { title: '推理强度', values: options.efforts ?? model?.efforts ?? [], fallback: '默认强度' },
      mode: { title: '模式', values: options.modes, fallback: '默认模式' },
    };
  }

  async function chooseOption(key) {
    if (!current) return;
    const list = optionLists()[key];
    const choices = valueChoices(list.values, current[key], list.fallback);
    const id = await pick({ title: list.title, choices, value: current[key] ?? '', placeholder: list.placeholder ?? '搜索' });
    if (id === null || id === (current[key] ?? '')) return;
    await configure(key, id);
  }

  function renderOptionsDialog() {
    if (!current) return;
    safetyChoices(get('chat-options-safety'), current.provider, current.safety, 'chat-options-safety');
    const options = current.options ?? {};
    const lists = optionLists();
    for (const key of ['model', 'effort', 'mode']) {
      const choice = valueChoices(lists[key].values, current[key], lists[key].fallback).find(item => item.id === (current[key] ?? ''));
      get('chat-options-' + key + '-value').textContent = choice?.label ?? lists[key].fallback;
    }
    get('chat-options-effort').hidden = !lists.effort.values?.length && !current.effort;
    get('chat-options-mode').hidden = current.provider !== 'opencode';
    const idle = idleLabel(current, Date.now(), '自动暂停');
    get('chat-options-context').textContent = providerInfo(current.provider).name + ' · ' + current.projectName
      + (current.running ? ' · Agent 在线' + (idle ? '（' + idle + '）' : '') : ' · Agent 已暂停，发送消息时恢复');
    get('chat-options-effort-hint').hidden = current.provider !== 'claude' || get('chat-options-effort').hidden;
    showError('chat-options-error', null);
  }

  async function configure(key, value) {
    if (!current) return;
    try {
      const meta = await deps.remote('agent_configure', { id: current.id, key, value });
      current = { ...current, ...meta };
      renderHeader();
      renderOptionsDialog();
    } catch (error) {
      renderOptionsDialog();
      if (get('chat-options-dialog').open) showError('chat-options-error', error);
      else setState(explain(error), 'error');
    }
  }

  async function renameThread() {
    if (!current) return;
    get('chat-rename-input').value = current.titleManual ? current.title : '';
    get('chat-rename-input').placeholder = threadTitle(current);
    showError('chat-rename-error', null);
    get('chat-rename-dialog').showModal();
  }

  // ---------- 默认设置与额度 ----------

  function renderSettingsDialog() {
    const box = get('chat-settings-list');
    box.replaceChildren();
    for (const entry of catalog ?? []) {
      const field = element('fieldset', 'setting-choices');
      safetyChoices(field, entry.id, entry.defaultSafety, 'chat-default-' + entry.id);
      field.querySelector('legend').textContent = entry.name + ' 默认安全选项';
      field.addEventListener('change', async event => {
        const safety = event.target.value;
        try {
          catalog = await deps.remote('agent_defaults', { provider: entry.id, safety });
          showError('chat-settings-error', null);
          get('chat-settings-status').textContent = entry.name + ' 默认已保存';
        } catch (error) {
          showError('chat-settings-error', error);
        }
        renderSettingsDialog();
      });
      box.append(field);
    }
  }

  async function openSettings() {
    try {
      await loadCatalog(true);
    } catch (error) {
      showError('chat-error', error);
      return;
    }
    get('chat-settings-status').textContent = '';
    showError('chat-settings-error', null);
    renderSettingsDialog();
    get('chat-settings-dialog').showModal();
  }

  function renderQuotaDialog(quotas) {
    const box = get('chat-quota-list');
    box.replaceChildren();
    for (const quota of quotas ?? []) {
      const card = element('section', 'quota-card');
      const head = element('div', 'quota-head');
      head.append(providerAvatar(quota.provider, true), element('strong', '', quota.name));
      if (quota.plan) head.append(element('span', 'status-chip', String(quota.plan)));
      card.append(head);
      const windows = quotaWindows(quota);
      for (const window of windows) {
        const row = element('div', 'quota-window');
        const label = element('div', 'quota-label');
        label.append(element('span', '', window.label), element('strong', '', window.percent + '%'));
        const bar = element('span', 'quota-bar');
        bar.dataset.tone = window.tone;
        const fill = element('span');
        fill.style.width = window.percent + '%';
        bar.append(fill);
        row.append(label, bar);
        if (window.reset) row.append(element('small', '', window.reset));
        card.append(row);
      }
      if (quota.error) card.append(element('p', 'error', quota.error));
      else if (!windows.length) card.append(element('p', 'hint', quota.note ?? '暂无额度数据，点「刷新」读取。'));
      if (quota.updatedAt) card.append(element('small', 'quota-time', '更新于 ' + relativeTime(quota.updatedAt)));
      box.append(card);
    }
  }

  async function openQuota(refresh = false) {
    const dialog = get('chat-quota-dialog');
    if (!dialog.open) dialog.showModal();
    const button = get('chat-quota-refresh');
    button.disabled = true;
    button.textContent = refresh ? '正在读取…' : '刷新';
    showError('chat-quota-error', null);
    try {
      const quotas = await deps.remote('agent_usage', { refresh });
      renderQuotaDialog(quotas);
      renderQuotaStrip(quotas);
      if (!refresh && !quotas.some(quota => quota.updatedAt)) {
        await openQuota(true);
        return;
      }
    } catch (error) {
      showError('chat-quota-error', error);
    } finally {
      button.disabled = false;
      button.textContent = '刷新';
    }
  }

  // ---------- 管理对话 ----------

  const busyThread = thread => thread.status === 'running' || thread.status === 'starting' || thread.pending > 0;
  const idleThread = thread => thread.running && !busyThread(thread);

  function manageState(thread) {
    if (busyThread(thread)) return threadStatus(thread).label;
    if (thread.running) return 'Agent 在线 · ' + (idleLabel(thread, Date.now(), '自动暂停') || '空闲');
    return 'Agent 已暂停 · 对话保留，发送消息时恢复';
  }

  function renderManage() {
    const box = get('chat-manage-list');
    const sorted = sortThreads(threads);
    box.replaceChildren(...sorted.map(thread => {
      const row = element('div', 'manage-row');
      row.dataset.running = String(!!thread.running);
      const text = element('span', 'row-text');
      text.append(
        element('strong', '', threadTitle(thread)),
        element('small', '', providerInfo(thread.provider).name + ' · ' + thread.projectName + ' · ' + relativeTime(thread.updatedAt)),
        element('small', 'manage-state', manageState(thread)),
      );
      const actions = element('span', 'manage-actions');
      if (thread.running) {
        const pause = element('button', 'secondary', '暂停');
        pause.type = 'button';
        pause.disabled = busyThread(thread);
        pause.setAttribute('aria-label', '暂停 Agent：' + threadTitle(thread));
        pause.addEventListener('click', () => { void manageAction([thread], 'agent_close'); });
        actions.append(pause);
      }
      const remove = element('button', 'secondary danger', '删除');
      remove.type = 'button';
      remove.disabled = busyThread(thread);
      remove.setAttribute('aria-label', '删除对话：' + threadTitle(thread));
      remove.addEventListener('click', async () => {
        if (await deps.confirm('删除对话？', `「${threadTitle(thread)}」会结束 Agent 进程并删除电脑端保存的对话记录；Agent 自己的会话记录不受影响。`, '删除')) {
          await manageAction([thread], 'agent_delete');
        }
      });
      actions.append(remove);
      row.append(providerAvatar(thread.provider), text, actions);
      return row;
    }));
    const idle = threads.filter(idleThread);
    const paused = threads.filter(thread => !thread.running && !busyThread(thread));
    get('chat-manage-pause-all').textContent = idle.length ? `暂停全部空闲 Agent（${idle.length}）` : '没有空闲的 Agent';
    get('chat-manage-pause-all').disabled = !idle.length;
    get('chat-manage-delete-paused').textContent = paused.length ? `删除已暂停的对话（${paused.length}）` : '没有已暂停的对话';
    get('chat-manage-delete-paused').disabled = !paused.length;
    get('chat-manage-empty').hidden = threads.length > 0;
  }

  async function manageAction(targets, op) {
    showError('chat-manage-error', null);
    const failed = [];
    for (const thread of targets) {
      try {
        await deps.remote(op, { id: thread.id });
        if (op === 'agent_delete') localStorage.removeItem(draftKey(thread.id));
      } catch (error) {
        if (error.revoked) {
          deps.onRevoked(error);
          return;
        }
        failed.push(threadTitle(thread) + '：' + explain(error));
      }
    }
    if (failed.length) showError('chat-manage-error', new Error(failed.join('\n')));
    await refreshList();
    renderManage();
  }

  async function openManage() {
    showError('chat-manage-error', null);
    await refreshList();
    renderManage();
    get('chat-manage-dialog').showModal();
  }

  // ---------- 项目入口 ----------

  function projectActions(project) {
    projectSheetTarget = project;
    get('chat-project-title').textContent = project.name;
    get('chat-project-context').textContent = projectSourceLabel(project);
    const supported = chatSupported(project);
    for (const button of get('chat-project-dialog').querySelectorAll('[data-provider]')) button.disabled = !supported || !deps.online();
    get('chat-project-unsupported').hidden = supported;
    get('chat-project-dialog').showModal();
  }

  // ---------- 事件 ----------

  get('chat-new').addEventListener('click', () => { void openNewDialog(); });
  get('chat-manage').addEventListener('click', () => { void openManage(); });
  get('chat-manage-pause-all').addEventListener('click', () => { void manageAction(threads.filter(idleThread), 'agent_close'); });
  get('chat-manage-delete-paused').addEventListener('click', async () => {
    const paused = threads.filter(thread => !thread.running && !busyThread(thread));
    if (await deps.confirm('删除已暂停的对话？', `将删除 ${paused.length} 段已暂停的对话记录，Agent 自己的会话记录不受影响。`, '删除')) {
      await manageAction(paused, 'agent_delete');
    }
  });
  get('chat-empty-action').addEventListener('click', () => {
    // 未连接、离线或需重新配对时沿用终端首页按钮的处理。
    if (!deps.profile() || !deps.online()) deps.connect();
    else void openNewDialog();
  });
  get('chat-terminals').addEventListener('click', () => deps.showPage('home'));
  get('chat-settings').addEventListener('click', () => { void openSettings(); });
  get('chat-quota').addEventListener('click', () => { void openQuota(false); });
  get('chat-quota-refresh').addEventListener('click', () => { void openQuota(true); });
  get('chat-new-project').addEventListener('click', () => { void chooseNewProject(); });
  get('chat-new-start').addEventListener('click', () => { void startNewThread(); });
  get('chat-back').addEventListener('click', () => closeThread());
  get('chat-thread-menu').addEventListener('click', () => {
    renderOptionsDialog();
    get('chat-options-dialog').showModal();
  });
  get('chat-safety').addEventListener('click', () => {
    renderOptionsDialog();
    get('chat-options-dialog').showModal();
  });
  // 模型按钮直接弹出模型选择，不再绕道对话设置。
  get('chat-model').addEventListener('click', () => { void chooseOption('model'); });
  get('chat-options-safety').addEventListener('change', event => {
    const option = safetyOption(catalog, current?.provider, event.target.value);
    void (async () => {
      if (option?.full && !await deps.confirm('切换为完全访问？', 'Agent 将不再请求手机确认，直接编辑文件和运行命令。', '完全访问')) {
        renderOptionsDialog();
        return;
      }
      await configure('safety', event.target.value);
    })();
  });
  get('chat-options-model').addEventListener('click', () => { void chooseOption('model'); });
  get('chat-options-effort').addEventListener('click', () => { void chooseOption('effort'); });
  get('chat-options-mode').addEventListener('click', () => { void chooseOption('mode'); });
  get('chat-options-rename').addEventListener('click', () => {
    get('chat-options-dialog').close();
    void renameThread();
  });
  get('chat-options-terminal').addEventListener('click', () => {
    const project = deps.projects().find(item => item.id === current?.projectId);
    get('chat-options-dialog').close();
    if (!project) {
      setState('项目已不在电脑端信任列表中。', 'error');
      return;
    }
    closeThread({ show: false });
    deps.openTerminal(project);
  });
  get('chat-options-close').addEventListener('click', async () => {
    if (!current) return;
    try {
      await deps.remote('agent_close', { id: current.id });
      get('chat-options-dialog').close();
      setState('Agent 已暂停，发送消息时自动恢复会话。');
    } catch (error) {
      showError('chat-options-error', error);
    }
  });
  get('chat-options-delete').addEventListener('click', async () => {
    if (!current) return;
    const id = current.id;
    if (!await deps.confirm('删除对话？', '会结束 Agent 进程并删除电脑端保存的这段对话记录；Agent 自己的会话记录不受影响。', '删除')) return;
    try {
      await deps.remote('agent_delete', { id });
      get('chat-options-dialog').close();
      localStorage.removeItem(draftKey(id));
      threads = threads.filter(thread => thread.id !== id);
      closeThread();
    } catch (error) {
      showError('chat-options-error', error);
    }
  });
  get('chat-rename-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!current) return;
    try {
      const meta = await deps.remote('agent_rename', { id: current.id, title: get('chat-rename-input').value });
      current = { ...current, ...meta };
      renderHeader();
      get('chat-rename-dialog').close();
    } catch (error) {
      showError('chat-rename-error', error);
    }
  });
  for (const button of get('chat-project-dialog').querySelectorAll('[data-provider]')) {
    button.addEventListener('click', () => {
      const project = projectSheetTarget;
      get('chat-project-dialog').close();
      void openNewDialog({ provider: button.dataset.provider, project: project?.id });
    });
  }
  get('chat-project-terminal').addEventListener('click', () => {
    const project = projectSheetTarget;
    get('chat-project-dialog').close();
    if (project) deps.openTerminal(project);
  });
  get('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    void submit();
  });
  get('chat-attach').addEventListener('click', () => { void attachImages(); });
  get('chat-older').addEventListener('click', () => { void loadOlder(); });
  get('chat-bottom').addEventListener('click', scrollToBottom);
  scroller.addEventListener('scroll', () => {
    if (nearBottom()) get('chat-bottom').hidden = true;
  }, { passive: true });
  input.addEventListener('input', () => {
    resizeInput();
    updateSendState();
    if (current) localStorage.setItem(draftKey(current.id), input.value);
  });

  // 首次加载时对话页已显示，但可能尚未调用 showPage。
  listVisible = !get('chat-screen').hidden && !get('dashboard').hidden;
  renderList();

  const dialogs = ['chat-manage-dialog', 'chat-rename-dialog', 'chat-options-dialog', 'chat-new-dialog', 'chat-settings-dialog', 'chat-quota-dialog', 'chat-project-dialog'];

  return {
    /** 切换工作台页面时调用。 */
    onPage(page) {
      setListVisible(page === 'chat');
    },
    /** 连接或项目变化后刷新。 */
    refresh() {
      if (catalogProfile !== deps.profile()?.id) catalog = null;
      if (listVisible) {
        renderList();
        void refreshList();
        void loadQuotaStrip();
      }
    },
    setForeground(visible) {
      const resumed = visible && !foreground;
      foreground = visible;
      if (!visible) {
        clearTimeout(listTimer);
        if (current) localStorage.setItem(draftKey(current.id), input.value);
        threadEpoch += 1;
        return;
      }
      if (resumed && current && !screen.hidden) startPolling();
      if (resumed && listVisible) setListVisible(true);
    },
    back() {
      for (const id of dialogs) {
        const dialog = get(id);
        if (dialog.open) {
          dialog.close('cancel');
          return true;
        }
      }
      return closeThread();
    },
    hideThread() {
      closeThread({ show: false });
    },
    /** 重开 App 时恢复上次打开的对话。 */
    async resume() {
      const id = localStorage.getItem(prefix + 'chat-open:' + (deps.profile()?.id ?? ''));
      if (!id || !deps.online()) return false;
      await refreshList();
      if (!threads.some(thread => thread.id === id)) return false;
      await openThread(id);
      return true;
    },
    projectActions,
    isOpen: () => !screen.hidden,
  };
}
