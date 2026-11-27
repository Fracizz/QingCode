/** 纯逻辑：控制行编解码、尺寸规整、后端选择、POSIX 引号。不碰任何 IO。 */

/** @typedef {{ ok: boolean, version?: string, detail?: string }} ProbeResult */
/** @typedef {{ python3: ProbeResult, script: ProbeResult, posix: boolean }} Capabilities */
/** @typedef {'python' | 'script'} Backend */
/** @typedef {'auto' | 'python' | 'script'} BackendPreference */

export class PtyUnavailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'PtyUnavailableError'
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
export function encodeControlLine(obj) {
  return `${JSON.stringify(obj)}\n`
}

/** 增量解析 fd 3 上的 JSON 行；半行、坏行都不能让宿主挂掉。 */
export class ControlLineDecoder {
  /** @type {string} */
  #buffer = ''

  /**
   * @param {string | Uint8Array} chunk
   * @returns {Array<Record<string, unknown>>}
   */
  push(chunk) {
    this.#buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const out = []
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.length > 0) {
        try {
          const value = JSON.parse(line)
          if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value)
        } catch {
          // 控制行损坏时忽略这一行，终端数据通道不受影响。
        }
      }
      newline = this.#buffer.indexOf('\n')
    }
    return out
  }

  reset() {
    this.#buffer = ''
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function clampSize(value, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(1000, n))
}

/** `script -c` 会再经一次 /bin/sh -c，必须把 shell 路径当作单个参数 quoting。 */
/** @param {string} text */
export function posixQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`
}

/**
 * @param {Capabilities} caps
 * @param {BackendPreference} [preferred]
 * @returns {Backend}
 */
export function chooseBackend(caps, preferred = 'auto') {
  const python = caps.posix && caps.python3?.ok === true
  const script = caps.posix && caps.script?.ok === true
  if (preferred === 'python') {
    if (python) return 'python'
    throw new PtyUnavailableError('python3 PTY 桥不可用：需要 POSIX + python3 标准库 pty/fcntl/termios')
  }
  if (preferred === 'script') {
    if (script) return 'script'
    throw new PtyUnavailableError('script 兜底不可用：需要 util-linux script（含 -q/-f/-e/-c）')
  }
  if (python) return 'python'
  if (script) return 'script'
  throw new PtyUnavailableError(
    '未找到可用的 PTY 后端：需要 python3（pty.fork + fcntl.ioctl）或 util-linux script；' +
      'Windows 本机必须改用 ConPTY 原生模块',
  )
}

/**
 * 把探测结果归一化，避免 `python3 -c` 输出里夹带告警时把 JSON 解析搞崩。
 * @param {string} stdout
 * @returns {{ ok: boolean, version: string, detail: string }}
 */
export function parsePythonProbe(stdout) {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, version: '', detail: 'python3 探测无 JSON 输出' }
  try {
    const value = JSON.parse(stdout.slice(start, end + 1))
    const ok = value.ok === true && value.pty === true
    return {
      ok,
      version: typeof value.version === 'string' ? value.version : '',
      detail: ok ? '' : String(value.detail ?? 'pty.fork 不可用'),
    }
  } catch (cause) {
    return { ok: false, version: '', detail: `python3 探测输出无效: ${String(cause)}` }
  }
}

/**
 * @param {string} versionText
 * @param {string} helpText
 * @returns {{ ok: boolean, version: string, detail: string }}
 */
export function parseScriptProbe(versionText, helpText) {
  const version = versionText.trim() || ''
  const hasFlags = ['--return', '--flush', '--command', '--quiet'].every((f) => helpText.includes(f))
  if (!hasFlags) {
    return { ok: false, version, detail: 'script 缺少 -q/-f/-e/-c 中的必要选项' }
  }
  return { ok: true, version, detail: '' }
}
