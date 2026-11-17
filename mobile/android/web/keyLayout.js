// 快捷键栏布局：用户可调整常用键顺序并隐藏不用的键；隐藏的键移入「更多」，不会丢失。
// 还可添加自定义键：键名 + 实际发送的文本（可选发送后回车）。
// 纯逻辑无 DOM，Vitest：src/lib/mobileAndroidKeyLayout.test.ts。

/** 常用键默认顺序（按 AI 编程使用频率），值为按钮的 data-key；方向与退格用 icon 指定的 SVG，字体字形的基线不一致。 */
export const SHORTCUT_KEYS = Object.freeze([
  { key: 'esc', label: 'Esc', name: 'Esc' },
  { key: 'tab', label: 'Tab', name: 'Tab' },
  { key: 'interrupt', label: '^C', name: 'Ctrl+C' },
  { key: 'shift-tab', label: '⇧Tab', name: 'Shift+Tab', icon: 'shift', iconText: 'Tab' },
  { key: 'up', label: '↑', name: '向上', icon: 'arrow-up' },
  { key: 'down', label: '↓', name: '向下', icon: 'arrow-down' },
  { key: 'backspace', label: '⌫', name: '退格', icon: 'backspace' },
  { key: 'slash', label: '/命令', name: '斜杠命令' },
  { key: 'left', label: '←', name: '向左', icon: 'arrow-left' },
  { key: 'right', label: '→', name: '向右', icon: 'arrow-right' },
]);

/** 自定义键在布局中的 key 前缀；按钮为 data-key="custom" data-custom-id。 */
export const CUSTOM_PREFIX = 'custom:';
export const CUSTOM_NAME_LIMIT = 24;
export const CUSTOM_TEXT_LIMIT = 200;
export const CUSTOM_KEY_LIMIT = 30;

const KNOWN = new Set(SHORTCUT_KEYS.map(item => item.key));

export function isCustomKey(key) {
  return typeof key === 'string' && key.startsWith(CUSTOM_PREFIX);
}

export function customKeyId(key) {
  return isCustomKey(key) ? key.slice(CUSTOM_PREFIX.length) : null;
}

/**
 * 校验并规整一个自定义键；无效时返回 null。
 * 文本去掉首尾空白、不允许换行和控制字符。
 */
export function normalizeCustomKey(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, CUSTOM_NAME_LIMIT) : '';
  if (typeof raw.text !== 'string') return null;
  const text = raw.text.trim();
  if (!text || text.length > CUSTOM_TEXT_LIMIT || /[\x00-\x1f\x7f]/.test(text)) return null;
  return { id, name, text, enter: raw.enter !== false };
}

/** 按钮上显示的文字：有名称用名称，否则用发送的文本。 */
export function customKeyLabel(def) {
  return def.name || def.text;
}

/** 编辑列表中的说明：实际发送的内容。 */
export function customKeyDetail(def) {
  return def.enter ? def.text + ' ↵' : def.text;
}

/** 按下自定义键时写入终端的内容：data 先发，enter 隔 250ms 再发（避免 TUI 把回车当作粘贴的一部分）。 */
export function customKeyInput(def) {
  return { data: def.text, enter: def.enter ? '\r' : '' };
}

export function defaultKeyLayout() {
  return { order: SHORTCUT_KEYS.map(item => item.key), hidden: [], custom: [] };
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
  const custom = [];
  for (const item of Array.isArray(saved.custom) ? saved.custom : []) {
    const def = normalizeCustomKey(item);
    if (def && custom.length < CUSTOM_KEY_LIMIT && !custom.some(other => other.id === def.id)) custom.push(def);
  }
  const customKeys = new Set(custom.map(def => CUSTOM_PREFIX + def.id));
  const valid = key => KNOWN.has(key) || customKeys.has(key);
  const order = [...new Set(saved.order.filter(valid))];
  for (const [index, { key }] of SHORTCUT_KEYS.entries()) {
    if (order.includes(key)) continue;
    // 新键插到默认顺序中前一个已存在键之后，保持用户已有的相对顺序。
    const before = SHORTCUT_KEYS.slice(0, index).map(item => item.key).reverse().find(previous => order.includes(previous));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, key);
  }
  for (const key of customKeys) if (!order.includes(key)) order.push(key);
  const hidden = Array.isArray(saved.hidden) ? [...new Set(saved.hidden.filter(valid))] : [];
  return { order, hidden, custom };
}

export function serializeKeyLayout(layout) {
  return JSON.stringify({ order: layout.order, hidden: layout.hidden, custom: layout.custom });
}

export function isDefaultKeyLayout(layout) {
  return serializeKeyLayout(layout) === serializeKeyLayout(defaultKeyLayout());
}

/** 新建自定义键的 id：与已有 id 不重复。 */
export function newCustomKeyId(layout, random = Math.random) {
  for (;;) {
    const id = 'k' + Math.floor(random() * 36 ** 6).toString(36);
    if (!layout.custom.some(def => def.id === id)) return id;
  }
}

/** 添加或修改自定义键：新键排到最后并显示在栏中；无效或超过数量上限时原样返回。 */
export function saveCustomKey(layout, raw) {
  const def = normalizeCustomKey(raw);
  if (!def) return layout;
  const index = layout.custom.findIndex(item => item.id === def.id);
  if (index >= 0) {
    const custom = [...layout.custom];
    custom[index] = def;
    return { ...layout, custom };
  }
  if (layout.custom.length >= CUSTOM_KEY_LIMIT) return layout;
  return { ...layout, custom: [...layout.custom, def], order: [...layout.order, CUSTOM_PREFIX + def.id] };
}

export function removeCustomKey(layout, id) {
  const key = CUSTOM_PREFIX + id;
  if (!layout.custom.some(def => def.id === id)) return layout;
  return {
    order: layout.order.filter(item => item !== key),
    hidden: layout.hidden.filter(item => item !== key),
    custom: layout.custom.filter(def => def.id !== id),
  };
}

export function findCustomKey(layout, key) {
  const id = customKeyId(key) ?? key;
  return layout.custom.find(def => def.id === id) ?? null;
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

/** 拖动排序：把 key 移到 index（按移动后的位置计）；越界时夹到两端，未知键原样返回。 */
export function moveKeyTo(layout, key, index) {
  const from = layout.order.indexOf(key);
  if (from < 0) return layout;
  const to = Math.max(0, Math.min(layout.order.length - 1, Math.trunc(index) || 0));
  if (to === from) return layout;
  const order = layout.order.filter(item => item !== key);
  order.splice(to, 0, key);
  return { ...layout, order };
}

/**
 * 拖动中的落点：mids 为拖动开始时各行中线的 Y，center 为被拖行当前中线。
 * 越过相邻行的中线才换位，返回松手后应插入的位置。
 */
/**
 * 拖动排序的落点探测点：上拖取被拖行上边、下拖取下边、未移动取中心。
 * 被拖行夹在列表边界内，用中心点时拖到顶 / 底恰好与首 / 末行中线重合、不算越过，到不了第一位和最后一位。
 */
export function dragProbe(mid, offset, half) {
  return mid + offset + (offset < 0 ? -half : offset > 0 ? half : 0);
}

export function dragTargetIndex(mids, from, center) {
  let to = from;
  while (to < mids.length - 1 && center > mids[to + 1]) to++;
  while (to > 0 && center < mids[to - 1]) to--;
  return to;
}

export function toggleKeyHidden(layout, key) {
  if (!KNOWN.has(key) && !findCustomKey(layout, key)) return layout;
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
