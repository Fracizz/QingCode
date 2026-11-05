// 「阅读与搜索输出」：终端缓存或已加载历史的只读快照，支持搜索跳转、折行、diff 着色与链接。
import { get, button } from './dom.js';
import { terminalText, searchOffsets } from './workspaceState.js';
import { findLinks } from './terminalLinks.js';

/** terminal() 返回当前 xterm 实例；historyOpen() 表示是否正在看只读历史。 */
export function createOutputReader({ rpc, terminal, historyOpen }) {
  let readerText = '';
  let readerMatches = [];
  let readerIndex = 0;

  function refresh() {
    const term = terminal();
    readerText = get('reader-source').value === 'history' ? get('history-content').textContent.slice(-600_000) : term ? terminalText(term) : '';
    get('reader-refresh').textContent = '刷新内容';
    render();
    get('reader-scroll').scrollTop = 0;
  }

  function render() {
    readerMatches = searchOffsets(readerText, get('reader-query').value);
    readerIndex = 0;
    const content = get('reader-content');
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let matchIndex = 0;
    for (const line of readerText.split('\n')) {
      const span = document.createElement('span');
      if (line.startsWith('+')) span.className = 'diff-added';
      if (line.startsWith('-')) span.className = 'diff-removed';
      let position = 0;
      while (matchIndex < readerMatches.length && readerMatches[matchIndex].start < offset + line.length) {
        const match = readerMatches[matchIndex];
        appendText(span, line.slice(position, Math.max(0, match.start - offset)));
        const mark = document.createElement('mark');
        mark.dataset.match = String(matchIndex);
        mark.textContent = line.slice(Math.max(0, match.start - offset), match.end - offset);
        span.append(mark);
        position = Math.min(line.length, match.end - offset);
        if (match.end > offset + line.length) break;
        matchIndex += 1;
      }
      appendText(span, line.slice(position) + '\n');
      fragment.append(span);
      offset += line.length + 1;
    }
    content.replaceChildren(fragment);
    updateMatch(false);
  }

  function appendText(parent, text) {
    let position = 0;
    for (const { start, end, url } of findLinks(text)) {
      parent.append(document.createTextNode(text.slice(position, start)));
      const link = button('reader-link', async () => {
        try { await rpc('open_link', { url }); }
        catch (error) { get('reader-status').textContent = error.message; }
      });
      link.textContent = url;
      link.setAttribute('role', 'link');
      parent.append(link);
      position = end;
    }
    parent.append(document.createTextNode(text.slice(position)));
  }

  function updateMatch(scroll = true) {
    for (const mark of get('reader-content').querySelectorAll('mark')) mark.dataset.active = String(Number(mark.dataset.match) === readerIndex);
    get('reader-status').textContent = get('reader-query').value
      ? readerMatches.length ? (readerIndex + 1) + ' / ' + readerMatches.length + (readerMatches.length === 500 ? '（最多 500 处）' : '') : '未找到'
      : readerText ? '只读快照' : '此范围暂无输出';
    if (scroll) get('reader-content').querySelector('mark[data-active="true"]')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  get('reader-refresh').addEventListener('click', refresh);
  get('reader-source').addEventListener('change', refresh);
  get('reader-query').addEventListener('input', () => { render(); updateMatch(); });
  for (const [id, delta] of [['reader-previous', -1], ['reader-next', 1]]) get(id).addEventListener('click', () => {
    if (!readerMatches.length) return;
    readerIndex = (readerIndex + delta + readerMatches.length) % readerMatches.length;
    updateMatch();
  });
  get('reader-wrap').addEventListener('change', () => { get('reader-content').dataset.wrap = String(get('reader-wrap').checked); });
  get('reader-copy').addEventListener('click', async () => {
    try { await rpc('copy', { text: readerText }); get('reader-status').textContent = '输出已复制'; }
    catch (error) { get('reader-status').textContent = error.message; }
  });

  return {
    open() {
      get('reader-source').value = historyOpen() ? 'history' : 'terminal';
      refresh();
      get('reader-dialog').showModal();
    },
    /** 阅读时有新输出只提示刷新，不替换正在阅读的快照。 */
    notifyOutput() {
      if (get('reader-dialog').open) get('reader-refresh').textContent = '刷新内容（有新输出）';
    },
  };
}
