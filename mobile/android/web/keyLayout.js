// 快捷键栏布局：用户可调整常用键顺序并隐藏不用的键；隐藏的键移入「更多」，不会丢失。
// 纯逻辑无 DOM，Vitest：src/lib/mobileAndroidKeyLayout.test.ts。

/** 常用键默认顺序（按 AI 编程使用频率），值为按钮的 data-key。 */
export const SHORTCUT_KEYS = Object.freeze([
  { key: 'esc', label: 'Esc', name: 'Esc' },
  { key: 'tab', label: 'Tab', name: 'Tab' },
  { key: 'interrupt', label: '^C', name: 'Ctrl+C' },
  { key: 'shift-tab', label: '⇧Tab', name: 'Shift+Tab' },
  { key: 'up', label: '↑', name: '向上' },
  { key: 'down', label: '↓', name: '向下' },
  { key: 'backspace', label: '⌫', name: '退格' },
  { key: 'slash', label: '/命令', name: '斜杠命令' },
  { key: 'left', label: '←', name: '向左' },
  { key: 'right', label: '→', name: '向右' },
]);

const KNOWN = new Set(SHORTCUT_KEYS.map(item => item.key));

export function defaultKeyLayout() {
  return { order: SHORTCUT_KEYS.map(item => item.key), hidden: [] };
}

/**
 * 解析保存的布局：丢弃未知键和重复项，新版本新增的键按默认位置补回，
 * 损坏或缺失时返回默认布局。
 */
export function parseKeyLayout(raw) {
  let saved;
  try {
    saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return defaultKeyLayout();
  }
  if (!saved || !Array.isArray(saved.order)) return defaultKeyLayout();
  const order = [...new Set(saved.order.filter(key => KNOWN.has(key)))];
  for (const [index, { key }] of SHORTCUT_KEYS.entries()) {
    if (order.includes(key)) continue;
    // 新键插到默认顺序中前一个已存在键之后，保持用户已有的相对顺序。
    const before = SHORTCUT_KEYS.slice(0, index).map(item => item.key).reverse().find(previous => order.includes(previous));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, key);
  }
  const hidden = Array.isArray(saved.hidden) ? [...new Set(saved.hidden.filter(key => KNOWN.has(key)))] : [];
  return { order, hidden };
}

export function serializeKeyLayout(layout) {
  return JSON.stringify({ order: layout.order, hidden: layout.hidden });
}

export function isDefaultKeyLayout(layout) {
  return !layout.hidden.length && layout.order.every((key, index) => key === SHORTCUT_KEYS[index].key);
}

/** 上移（delta = -1）或下移（delta = 1）一位；越界时原样返回。 */
export function moveKey(layout, key, delta) {
  const from = layout.order.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= layout.order.length) return layout;
  const order = [...layout.order];
  [order[from], order[to]] = [order[to], order[from]];
  return { ...layout, order };
}

export function toggleKeyHidden(layout, key) {
  if (!KNOWN.has(key)) return layout;
  const hidden = layout.hidden.includes(key) ? layout.hidden.filter(item => item !== key) : [...layout.hidden, key];
  return { ...layout, hidden };
}

/** 快捷键栏实际显示的键（按顺序）与移入「更多」的键（同样按顺序）。 */
export function visibleKeys(layout) {
  const hidden = new Set(layout.hidden);
  return {
    bar: layout.order.filter(key => !hidden.has(key)),
    overflow: layout.order.filter(key => hidden.has(key)),
  };
}

export function keyInfo(key) {
  return SHORTCUT_KEYS.find(item => item.key === key);
}
