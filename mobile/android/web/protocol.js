// QingCode Android 的纯逻辑：配对链接、终端输出块、输入拆分与按键序列。
// app.js 与 Vitest（src/lib/mobileAndroidProtocol.test.ts）共用，不得访问 DOM。

export const PAIRING_PREFIX = 'qingcode://pair?';
export const DEFAULT_PORT = 48764;
export const INPUT_SLICE = 2048;

/** 保留连接名称和实际主机；连接名为 WSL 的 SSH 项目仍使用远端通道。 */
export function projectSourceLabel(project) {
  const kind = { local: '本机', wsl: 'WSL', ssh: '远端' }[project.kind] || '项目';
  const parts = project.kind === 'local' ? [kind] : [kind, project.connectionName, project.host];
  return [...new Set(parts.filter(Boolean))].join(' · ');
}

export function matchesProject(project, kind, query) {
  const search = query.trim().toLowerCase();
  return (kind === 'all' || project.kind === kind)
    && [project.name, project.path, projectSourceLabel(project)].some(value => String(value ?? '').toLowerCase().includes(search));
}

export function validIpv4(host) {
  const octets = String(host).split('.');
  return octets.length === 4 && octets.every(octet => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
}

export function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 解析 Windows 设置页生成的配对链接（见 src/lib/mobilePairing.ts）。 */
export function parsePairingLink(text) {
  const value = String(text ?? '').trim();
  if (!value.startsWith(PAIRING_PREFIX)) throw new Error('这不是 QingCode 配对链接。');
  const query = new URLSearchParams(value.slice(PAIRING_PREFIX.length));
  if (query.get('v') !== '1') throw new Error('配对链接版本不受支持，请升级 QingCode Android。');
  const host = query.get('host') ?? '';
  const port = Number(query.get('port'));
  const fingerprint = (query.get('fp') ?? '').toLowerCase();
  if (!validIpv4(host) || !validPort(port)) throw new Error('配对链接中的地址无效。');
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('配对链接中的证书指纹无效。');
  const name = (query.get('name') ?? '').trim().slice(0, 48) || 'Windows';
  return { host, port, fingerprint, name };
}

export function decodeBase64(chunk) {
  return Uint8Array.from(atob(chunk), character => character.charCodeAt(0));
}

/**
 * 普通输出块是 base64 字节；屏幕快照是 `{ data, cols, rows }`，data 为可直接写入 xterm 的终端文本。
 */
export function outputChunk(chunk) {
  if (typeof chunk === 'string') return { screen: false, data: decodeBase64(chunk) };
  return { screen: true, data: String(chunk.data), cols: chunk.cols, rows: chunk.rows };
}

/** 按 UTF-16 长度切片，不拆开代理对。 */
export function splitInput(text, size = INPUT_SLICE) {
  const parts = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

const CONTROL_SYMBOLS = { '@': 0, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, '?': 127 };

/** 一次性 Ctrl / Alt：Ctrl 映射单个字母或符号，Alt 以 ESC 前缀发送。 */
export function applyModifiers(value, { ctrl = false, alt = false } = {}) {
  let result = value;
  if (ctrl && result.length === 1) {
    if (/^[a-z]$/i.test(result)) result = String.fromCharCode(result.toUpperCase().charCodeAt(0) & 31);
    else if (result in CONTROL_SYMBOLS) result = String.fromCharCode(CONTROL_SYMBOLS[result]);
  }
  if (alt && result.length > 0) result = '\x1b' + result;
  return result;
}

const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE_KEYS = { pgup: '5~', pgdn: '6~' };

export function keySequence(key, { applicationCursor = false } = {}) {
  if (key === 'esc') return '\x1b';
  if (key === 'tab') return '\t';
  if (key in TILDE_KEYS) return '\x1b[' + TILDE_KEYS[key];
  if (key in ARROWS) return (applicationCursor ? '\x1bO' : '\x1b[') + ARROWS[key];
  throw new Error('unknown key ' + key);
}

/** 连接地址变化（如电脑端改端口）时，迁移以连接 id 为键的本地记录。 */
export function renameProfileKeys(keys, prefix, from, to) {
  const moves = [];
  for (const key of keys) {
    for (const scope of ['session:', 'project:']) {
      const old = prefix + scope + from;
      if (key === old || key.startsWith(old + ':')) moves.push([key, prefix + scope + to + key.slice(old.length)]);
    }
  }
  return moves;
}
