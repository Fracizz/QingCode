// 命令栏与终端候选共用的输入计划；不猜测 Claude / OpenCode 的技能列表。
export function isSlashDraft(value) {
  return /^\/[^\r\n]*$/.test(value);
}

/** 交互输入不带回车，让终端显示自己的候选，用户另行确认。 */
export function composerInput(value, action, bracketedPaste = false) {
  if (action === 'slash' || action === 'complete') {
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
