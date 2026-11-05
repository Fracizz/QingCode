// 软键盘弹出时保持终端行数。
// Android 用 adjustResize 处理输入法：键盘弹出、草稿框变高都会让终端区域变矮。
// 如果跟着缩小行数并同步给电脑端 PTY，Claude Code / Codex 收到尺寸变化后会整块重绘底部区域，
// 旧的状态栏、输入框被挤进滚动记录，手机和电脑端历史里都会出现重复画面。

/** 高度比本宽度下见过的最大高度少这么多像素，就认为是软键盘打开（地址栏、快捷键栏的变化都更小）。 */
export const KEYBOARD_MIN_HEIGHT = 150;

export function keyboardLikelyOpen(height, maxHeight) {
  return maxHeight - height >= KEYBOARD_MIN_HEIGHT;
}

/** 应使用的终端行数：键盘打开且列数不变时只增不减，其余情况按实际可容纳行数。 */
export function heldTerminalRows({ fitRows, currentRows, sameColumns, keyboardOpen }) {
  if (keyboardOpen && sameColumns && currentRows > fitRows) return currentRows;
  return fitRows;
}

/** 保留行数时画面要上移几行：让光标所在行留在可见区域内。visibleRows 为 0 表示未保留。 */
export function heldRowOffset(rows, visibleRows, cursorY) {
  if (!visibleRows || visibleRows >= rows) return 0;
  const hidden = rows - visibleRows;
  return Math.max(0, Math.min(hidden, (Number(cursorY) || 0) + 1 - visibleRows));
}
