// 快捷键栏布局：用户可调整常用键顺序并隐藏不用的键；隐藏的键移入「更多」，不会丢失。
// 还可添加自定义键：键名 + 实际发送的文本（可选发送后回车），或一组特殊按键（如 Ctrl+D、F5、Esc : w q Enter）。
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

/** 特殊按键序列最多几个按键。 */
export const SPECIAL_KEY_LIMIT = 16;

const MODIFIER_ALIASES = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', meta: 'alt', option: 'alt', shift: 'shift' };
/** 命名键：小写别名 → 规范名。 */
const NAMED_KEYS = {
  esc: 'Esc', escape: 'Esc', tab: 'Tab', enter: 'Enter', return: 'Enter', space: 'Space',
  backspace: 'Backspace', bs: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pgup: 'PgUp', pageup: 'PgUp', pgdn: 'PgDn', pagedown: 'PgDn',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right',
};
for (let index = 1; index <= 12; index++) NAMED_KEYS['f' + index] = 'F' + index;
/** 编辑弹层里一键插入的常用特殊按键（规范名；以 + 结尾的是修饰键前缀）。 */
export const SPECIAL_KEY_PRESETS = Object.freeze([
  'Ctrl+', 'Alt+', 'Shift+', 'Esc', 'Tab', 'Enter', 'Space', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PgUp', 'PgDn', 'Up', 'Down', 'Left', 'Right',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const CURSOR_FINAL = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' };
const TILDE_CODE = { Insert: 2, Delete: 3, PgUp: 5, PgDn: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const SS3_FINAL = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };
/** Ctrl+符号 / 数字对应的控制字符（与常见终端一致）。 */
const CTRL_SYMBOLS = { '@': 0, '2': 0, '[': 27, '3': 27, '\\': 28, '4': 28, ']': 29, '5': 29, '^': 30, '6': 30, '_': 31, '/': 31, '7': 31, '?': 127, '8': 127 };

/** 解析一个按键（如 `Ctrl+Alt+X`、`F5`、`^C`、`:`）；无效时返回 null。 */
export function parseSpecialKey(token) {
  if (typeof token !== 'string' || !token || /\s/.test(token)) return null;
  // ^C 是 Ctrl+C 的常见写法；单独的 ^ 仍是普通字符。
  if (/^\^[A-Za-z@[\\\]^_?]$/.test(token)) token = 'Ctrl+' + token[1];
  let key;
  let mods = [];
  if ([...token].length === 1) key = token;
  else if (token.endsWith('++')) { key = '+'; mods = token.slice(0, -2).split('+'); }
  else { const parts = token.split('+'); key = parts.pop(); mods = parts; }
  const flags = { ctrl: false, alt: false, shift: false };
  for (const mod of mods) {
    const name = MODIFIER_ALIASES[mod.toLowerCase()];
    if (!name || flags[name]) return null;
    flags[name] = true;
  }
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) key = named;
  else if ([...key].length !== 1 || /[\x00-\x20\x7f]/.test(key)) return null;
  else if (flags.ctrl || flags.shift) key = key.toUpperCase();
  const parsed = { ...flags, key, named: Boolean(named) };
  return encodeSpecialKey(parsed) === null ? null : parsed;
}

function specialKeyName({ ctrl, alt, shift, key }) {
  return (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + key;
}

/** 一个按键写入终端的序列（xterm 约定）；不支持的组合返回 null。 */
function encodeSpecialKey({ ctrl, alt, shift, key, named }, { applicationCursor = false } = {}) {
  const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const meta = alt ? '\x1b' : '';
  if (!named) {
    if (ctrl) {
      if (shift) return null;
      const code = /^[A-Z]$/.test(key) ? key.charCodeAt(0) - 64 : CTRL_SYMBOLS[key];
      return code === undefined ? null : meta + String.fromCharCode(code);
    }
    if (shift && !/^[A-Z]$/.test(key)) return null;
    return meta + key;
  }
  if (key in CURSOR_FINAL) return mod === 1 ? (applicationCursor ? '\x1bO' : '\x1b[') + CURSOR_FINAL[key] : `\x1b[1;${mod}${CURSOR_FINAL[key]}`;
  if (key in SS3_FINAL) return mod === 1 ? '\x1bO' + SS3_FINAL[key] : `\x1b[1;${mod}${SS3_FINAL[key]}`;
  if (key in TILDE_CODE) return mod === 1 ? `\x1b[${TILDE_CODE[key]}~` : `\x1b[${TILDE_CODE[key]};${mod}~`;
  switch (key) {
    case 'Esc': return mod === 1 ? '\x1b' : null;
    case 'Tab': return ctrl ? null : shift ? (alt ? null : '\x1b[Z') : meta + '\t';
    case 'Enter': return ctrl || shift ? null : meta + '\r';
    case 'Space': return shift ? null : meta + (ctrl ? '\x00' : ' ');
    case 'Backspace': return shift ? null : meta + (ctrl ? '\x08' : '\x7f');
    default: return null;
  }
}

/**
 * 校验并规整特殊按键序列：空白分隔的按键（如 `Ctrl+D`、`Esc : w q Enter`），返回规范写法；无效时返回 null。
 */
export function normalizeSpecialKeys(raw) {
  if (typeof raw !== 'string') return null;
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > SPECIAL_KEY_LIMIT) return null;
  const names = [];
  for (const token of tokens) {
    const parsed = parseSpecialKey(token);
    if (!parsed) return null;
    names.push(specialKeyName(parsed));
  }
  const keys = names.join(' ');
  return keys.length > CUSTOM_TEXT_LIMIT ? null : keys;
}

/** 特殊按键序列逐键对应的写入片段（keys 须已规整）。 */
export function specialKeySequences(keys, options = {}) {
  return keys.split(' ').map(token => encodeSpecialKey(parseSpecialKey(token), options));
}

/**
 * 校验并规整一个自定义键；无效时返回 null。
 * 文本键：文本原样保留首尾空格（如 `git commit -m ` 依赖结尾空格），但不能全是空白，不允许换行和控制字符。
 * 特殊按键键：keys 为规范写法，text 为空、enter 为 false。
 */
export function normalizeCustomKey(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, CUSTOM_NAME_LIMIT) : '';
  if (typeof raw.keys === 'string' && raw.keys.trim()) {
    const keys = normalizeSpecialKeys(raw.keys);
    return keys ? { id, name, text: '', enter: false, keys } : null;
  }
  if (typeof raw.text !== 'string') return null;
  const text = raw.text;
  if (!text.trim() || text.length > CUSTOM_TEXT_LIMIT || /[\x00-\x1f\x7f]/.test(text)) return null;
  return { id, name, text, enter: raw.enter !== false };
}

/** 按钮上显示的文字：有名称用名称，否则用发送的文本或按键。 */
export function customKeyLabel(def) {
  return def.name || def.keys || def.text;
}

/** 编辑列表中的说明：实际发送的内容。 */
export function customKeyDetail(def) {
  if (def.keys) return def.keys;
  return def.enter ? def.text + ' ↵' : def.text;
}

/**
 * 按下自定义键时写入终端的内容：文本键 data 先发，enter 隔 250ms 再发（避免 TUI 把回车当作粘贴的一部分）；
 * 特殊按键键返回 keys，由调用方逐键单独写入（避免 Esc 与后续字符被合并成 Alt 组合）。
 */
export function customKeyInput(def, options = {}) {
  if (def.keys) return { data: '', enter: '', keys: specialKeySequences(def.keys, options) };
  return { data: def.text, enter: def.enter ? '\r' : '' };
}

export function defaultKeyLayout(custom = []) {
  const order = [...SHORTCUT_KEYS.map(item => item.key), ...custom.map(def => CUSTOM_PREFIX + def.id)];
  return { order, hidden: [], custom };
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
  const { order } = defaultKeyLayout(layout.custom);
  return !layout.hidden.length && layout.order.length === order.length
    && layout.order.every((key, index) => key === order[index]);
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

/**
 * 导入电脑端的自定义键：文本与「发送后回车」都相同视为同一个键，跳过；超过上限时停止。
 * 返回合并后的布局与实际新增数量。新键排到最后并显示在栏中。
 */
export function mergeCustomKeys(layout, incoming, random = Math.random) {
  let next = layout;
  let added = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const candidate = normalizeCustomKey({ ...(raw && typeof raw === 'object' ? raw : {}), id: 'import' });
    if (!candidate) continue;
    if (next.custom.some(def => def.text === candidate.text && def.enter === candidate.enter && (def.keys ?? '') === (candidate.keys ?? ''))) continue;
    if (next.custom.length >= CUSTOM_KEY_LIMIT) break;
    next = saveCustomKey(next, { ...candidate, id: newCustomKeyId(next, random) });
    added++;
  }
  return { layout: next, added };
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
