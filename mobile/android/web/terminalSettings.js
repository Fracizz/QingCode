// 「终端设置」弹层中仅保存在手机上的偏好：字号、列宽、全屏程序触摸、发送按键、图片压缩。
import { get } from './dom.js';
import { FONT_MAX, FONT_MIN, clampFontSize } from './pinchZoom.js';

/**
 * onFontSize(size) 在字号变化后重新适配终端；onColumns() 在列宽变化后重新适配；
 * onSendMode() 在发送按键设置变化后刷新发送按钮。
 */
export function createTerminalSettings({ prefix, onFontSize, onColumns, onSendMode }) {
  const savedFontSize = Number(localStorage.getItem(prefix + 'font-size'));
  let fontSize = Number.isInteger(savedFontSize) && savedFontSize >= FONT_MIN && savedFontSize <= FONT_MAX ? savedFontSize : 13;
  const savedColumns = localStorage.getItem(prefix + 'columns');
  let columns = ['80', '100'].includes(savedColumns) ? Number(savedColumns) : 0;
  // 全屏程序中的触摸：view 只看手机端历史、不向程序发鼠标事件（默认）；program 把滑动和点按发给程序。
  let touchMode = localStorage.getItem(prefix + 'touch-mode') === 'program' ? 'program' : 'view';
  // 发送按键：default 保持原行为；enter 为文字送达后单独补发回车。
  let sendMode = localStorage.getItem(prefix + 'send-mode') === 'enter' ? 'enter' : 'default';
  const compression = get('image-compression');

  function renderFontSize() {
    get('font-size').textContent = fontSize + 'px';
    get('font-smaller').disabled = fontSize <= FONT_MIN;
    get('font-larger').disabled = fontSize >= FONT_MAX;
  }

  /** persist 为假时只预览（双指缩放过程中），松手后再保存。 */
  function setFontSize(size, { persist = true } = {}) {
    const next = clampFontSize(size);
    const changed = next !== fontSize;
    fontSize = next;
    if (persist) localStorage.setItem(prefix + 'font-size', String(fontSize));
    renderFontSize();
    if (changed) onFontSize(fontSize);
  }

  for (const [id, delta] of [['font-smaller', -1], ['font-larger', 1]]) {
    get(id).addEventListener('click', () => setFontSize(fontSize + delta));
  }
  renderFontSize();

  get('terminal-columns').value = String(columns);
  get('terminal-columns').addEventListener('change', () => {
    columns = Number(get('terminal-columns').value);
    localStorage.setItem(prefix + 'columns', String(columns));
    onColumns();
  });

  get('touch-mode').querySelector(`input[value="${touchMode}"]`).checked = true;
  get('touch-mode').addEventListener('change', event => {
    touchMode = event.target.value === 'program' ? 'program' : 'view';
    localStorage.setItem(prefix + 'touch-mode', touchMode);
  });

  get('send-mode').value = sendMode;
  get('send-mode').addEventListener('change', () => {
    sendMode = get('send-mode').value === 'enter' ? 'enter' : 'default';
    localStorage.setItem(prefix + 'send-mode', sendMode);
    onSendMode();
  });

  const savedCompression = localStorage.getItem(prefix + 'image-compression');
  if (['original', 'low', 'medium', 'high'].includes(savedCompression)) compression.value = savedCompression;
  compression.addEventListener('change', () => localStorage.setItem(prefix + 'image-compression', compression.value));

  return {
    fontSize: () => fontSize,
    setFontSize,
    columns: () => columns,
    touchMode: () => touchMode,
    sendMode: () => sendMode,
    compression: () => compression.value,
  };
}
