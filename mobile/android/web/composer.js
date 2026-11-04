// 命令栏与终端候选共用的输入计划；不猜测 Claude / OpenCode 的技能列表。
export function isSlashDraft(value) {
  return /^\/[^\r\n]*$/.test(value);
}

/** 交互输入不带回车，让终端显示自己的候选，用户另行确认。 */
export function composerInput(value, action, bracketedPaste = false) {
  if (action === 'slash' || action === 'complete' || action === 'preview') {
    // 多行草稿不能作为补全前缀发送，保留在命令栏中。
    if (/[\r\n]/.test(value)) return null;
    const prefix = action === 'slash' && !value.startsWith('/') ? '/' : '';
    return { data: prefix + value + (action === 'complete' ? '\t' : ''), interactive: true };
  }
  if (isSlashDraft(value)) return { data: value, interactive: true };
  const text = value.replace(/\r?\n/g, '\r');
  const data = text.includes('\r') && bracketedPaste ? '\x1b[200~' + text + '\x1b[201~' : text;
  return { data: data + '\r', interactive: false };
}

const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** 本地草稿编辑以字素为边界，不能把中文、代理对或组合 emoji 删成半个字符。 */
export function editDraft(value, start, end, action, text = '') {
  const segments = graphemes ? [...graphemes.segment(value)].map(part => part.index) : [0];
  if (!graphemes) for (const character of value) segments.push(segments.at(-1) + character.length);
  const boundaries = [...new Set([...segments, value.length])];
  const endBoundary = boundaries.find(position => position >= end) ?? value.length;
  start = start === end ? endBoundary : ([...boundaries].reverse().find(position => position <= start) ?? 0);
  end = endBoundary;
  const before = [...segments].reverse().find(position => position < start) ?? 0;
  const after = segments.find(position => position > end) ?? value.length;
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  if (action === 'left' || action === 'right' || action === 'home' || action === 'end') {
    const at = action === 'left' ? (start === end ? before : start) :
      action === 'right' ? (start === end ? after : end) :
        action === 'home' ? lineStart :
          (value.indexOf('\n', end) < 0 ? value.length : value.indexOf('\n', end));
    return { value, start: at, end: at };
  }
  if (action === 'clear') return { value: '', start: 0, end: 0 };
  if (start === end) {
    if (action === 'backspace') start = before;
    else if (action === 'delete-word') start = value.slice(0, start).replace(/(?:\S+\s*|\s+)$/u, '').length;
    else if (action === 'delete-line-start') start = lineStart;
  }
  const insert = action === 'text' ? text : action === 'newline' ? '\n' : '';
  return { value: value.slice(0, start) + insert + value.slice(end), start: start + insert.length, end: start + insert.length };
}
