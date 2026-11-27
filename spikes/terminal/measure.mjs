// @ts-nocheck
/**
 * 93 上的自动实测：全屏程序、中文、Ctrl+C、resize、exit 退出码、10MB 吞吐与延迟。
 * 结果以 JSON 打到 stdout；诊断走 stderr；所有临时文件只在 QN_SPIKE_DIR/work 下。
 * 一次性测量脚本：shell 命令字符串与回调都是动态的，不做类型标注。
 */
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnPty } from './pty.mjs'
import { detectCapabilities } from './probe.mjs'

const scratch = process.env.QN_SPIKE_DIR
  ? path.join(process.env.QN_SPIKE_DIR, 'work')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'qn-spike-measure-'))
fs.mkdirSync(scratch, { recursive: true })
const diag = (line) => process.stderr.write(`[measure] ${line}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const caps = await detectCapabilities()
const sh = (cmd) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }).stdout.trim()
const tools = {}
for (const name of ['vim', 'htop', 'vi', 'nano', 'top', 'less', 'screen', 'python3', 'script']) {
  tools[name] = sh(`command -v ${name} || true`) || null
}

const sample = Array.from({ length: 240 }, (_, i) => `line ${i + 1} / 中文 ${i + 1}`).join('\n') + '\n'
fs.writeFileSync(path.join(scratch, 'sample.txt'), sample, 'utf8')

const CURSES_APP = `import curses, os, time
mark = os.environ.get('QN_TOKEN', 'x')
os.write(2, ('QN_CURSES_START_' + mark + '\\n').encode())
def main(stdscr):
    h, w = stdscr.getmaxyx()
    stdscr.addstr(0, 0, ('QN_CURSES_READY_%s_%dx%d' % (mark, w, h))[:max(1, w - 1)])
    stdscr.refresh()
    stdscr.timeout(200)
    end = time.time() + 12
    while time.time() < end:
        ch = stdscr.getch()
        if ch == curses.KEY_RESIZE:
            h, w = stdscr.getmaxyx()
            os.write(2, ('QN_CURSES_RESIZED_%s_%dx%d\\n' % (mark, w, h)).encode())
            return
        if ch in (3, ord('q')):
            return
curses.wrapper(main)
`
fs.writeFileSync(path.join(scratch, 'curses_app.py'), CURSES_APP, 'utf8')

const meta = {
  host: '192.168.10.93',
  uname: sh('uname -sr'),
  node: process.version,
  python3: sh('python3 --version 2>&1'),
  python3ProbeVersion: caps.pythonVersion,
  script: sh('script --version 2>&1'),
  utilLinuxFlags: caps.script.detail || 'ok',
  bash: sh('bash --version | head -1'),
  locale: process.env.LANG ?? '',
  term: process.env.TERM ?? 'xterm-256color',
  tools,
  scratch,
}

/** 收集输出；文本只留尾部用于匹配标记，字节流按上限留作校验。 */
class Output extends EventEmitter {
  constructor(pty) {
    super()
    this.total = 0
    this.kept = 0
    this.chunks = []
    this.tail = ''
    // 不能把返回值挂在 this.off 上，那会覆盖 EventEmitter.off。
    this.detachData = pty.onData((chunk) => {
      this.total += chunk.byteLength
      if (this.kept < 12 * 1024 * 1024) {
        this.chunks.push(chunk)
        this.kept += chunk.byteLength
      }
      this.tail = (this.tail + chunk.toString('utf8')).slice(-65536)
      this.emit('chunk')
    })
  }

  raw() {
    return Buffer.concat(this.chunks)
  }

  plain() {
    return this.tail
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[()][AB0]/g, '')
      .replace(/\r/g, '')
  }

  has(marker) {
    return this.plain().includes(marker)
  }

  waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      let cleanup
      const check = () => {
        if (predicate(this)) {
          cleanup()
          resolve(this)
        } else if (Date.now() - started > timeoutMs) {
          cleanup()
          reject(new Error(`等待超时: ${label}; 总字节=${this.total}; 尾部=${JSON.stringify(this.plain().slice(-400))}`))
        }
      }
      cleanup = () => {
        clearInterval(timer)
        this.off('chunk', check)
      }
      const timer = setInterval(check, 15)
      this.on('chunk', check)
      check()
    })
  }
}

/** @param {ReturnType<typeof spawnPty>} pty */
function waitForControl(pty, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let off = () => {}
    const timer = setTimeout(() => {
      off()
      reject(new Error(`控制消息超时: ${label}`))
    }, timeoutMs)
    off = pty.onControl((msg) => {
      if (!predicate(msg)) return
      clearTimeout(timer)
      off()
      resolve(msg)
    })
  })
}

/** @param {ReturnType<typeof spawnPty>} pty @param {() => any} getExit @param {number} timeoutMs */
function waitForExit(pty, getExit, timeoutMs = 4000) {
  if (getExit()) return Promise.resolve(getExit())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('等待退出超时'))
    }, timeoutMs)
    const off = pty.onExit((info) => {
      clearTimeout(timer)
      off()
      resolve(info)
    })
  })
}

const cases = []
const only = process.env.QN_SPIKE_ONLY
  ? new Set(process.env.QN_SPIKE_ONLY.split(',').map((s) => s.trim()))
  : null

async function runCase(name, backend, fn) {
  if (only && !only.has(name)) {
    cases.push({ name, backend, ok: false, skipped: true, error: 'QN_SPIKE_ONLY 过滤' })
    return
  }
  const started = performance.now()
  try {
    const detail = await fn(backend)
    cases.push({ name, backend, ok: true, ms: round(performance.now() - started), detail })
    diag(`OK   ${name} [${backend}] ${JSON.stringify(detail)}`)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    cases.push({ name, backend, ok: false, ms: round(performance.now() - started), error: message })
    diag(`FAIL ${name} [${backend}] ${message}`)
  }
}

/** 每个 case 起独立 shell；结束一定回收进程（含 script 的整组）。 */
async function withPty(backend, fn, options = {}) {
  const token = Math.random().toString(36).slice(2, 10)
  const pty = spawnPty({
    shell: '/bin/bash',
    args: ['--noprofile', '--norc', '-i'],
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: scratch,
    env: { QN_TOKEN: token, QN_MARK: token, PS1: '' },
    backend,
    capabilities: caps,
  })
  const out = new Output(pty)
  let exit = null
  pty.onExit((info) => {
    exit = info
  })
  pty.onStderr((chunk) => diag(`桥 stderr: ${chunk.toString('utf8').trim().slice(0, 300)}`))
  try {
    await pty.waitReady(8000)
    return await fn({ pty, out, token, getExit: () => exit })
  } finally {
    if (!exit) {
      try {
        pty.write('exit 0\n')
      } catch {
        // 已经结束。
      }
      await sleep(150)
      pty.kill()
    }
    await waitForExit(pty, () => exit, 3500).catch(() => pty.kill('SIGKILL'))
    out.detachData?.()
  }
}

const marker = (prefix, token) => `${prefix}_${token}`
const doneLine = (prefix) => `printf '\\n${prefix}_%s\\n' "$QN_TOKEN"`

async function initShell(pty, out, token) {
  pty.write(`stty -echo 2>/dev/null; ${doneLine('QN_INIT')}\n`)
  await out.waitFor((o) => o.has(marker('QN_INIT', token)), 8000, 'shell init')
}

// ---------- 基础：中文 / Ctrl+C / resize / 退出码 ----------
async function caseChinese(backend) {
  return withPty(backend, async ({ pty, out, token }) => {
    await initShell(pty, out, token)
    pty.write(`printf 'QN_ZH_%s_%s\\n' '中文测试 ✓ Ω' "$QN_TOKEN"; ${doneLine('QN_ZH_DONE')}\n`)
    await out.waitFor((o) => o.has(marker('QN_ZH_DONE', token)), 8000, '中文输出')
    const raw = out.raw()
    return {
      utf8Intact: raw.includes(Buffer.from('中文测试', 'utf8')),
      nonAsciiIntact: raw.includes(Buffer.from('Ω', 'utf8')),
      outputBytes: out.total,
    }
  })
}

async function caseCtrlC(backend) {
  return withPty(backend, async ({ pty, out, token }) => {
    await initShell(pty, out, token)
    pty.write(`printf 'QN_SLEEP_%s\\n' "$QN_TOKEN"; sleep 30; printf 'QN_NOINT_%s\\n' "$QN_TOKEN"\n`)
    await out.waitFor((o) => o.has(marker('QN_SLEEP', token)), 8000, 'sleep 启动')
    // 让 shell 真正进入 sleep 再发中断：过早的 ^C 可能落在命令行尾部而非前台进程组。
    await sleep(150)
    const t0 = performance.now()
    pty.write('\u0003')
    // bash 处理 SIGINT 时会丢弃 typeahead，过早写入的标记命令会被吞掉。
    let afterSeen = false
    let backToPromptMs = null
    for (let attempt = 0; attempt < 24 && !afterSeen; attempt += 1) {
      await sleep(150)
      pty.write(`${doneLine('QN_AFTER')}\n`)
      afterSeen = await out
        .waitFor((o) => o.has(marker('QN_AFTER', token)), 250, 'Ctrl+C 后继续接受输入')
        .then(() => true)
        .catch(() => false)
      if (afterSeen && backToPromptMs === null) backToPromptMs = round(performance.now() - t0)
    }
    if (!afterSeen) {
      throw new Error(
        `Ctrl+C 后未回到 shell（exited=${pty.exited}）: ${JSON.stringify(out.plain().slice(-300))}`,
      )
    }
    return {
      interrupted: !out.has(marker('QN_NOINT', token)),
      backToPromptMs,
    }
  })
}

async function caseResize(backend) {
  return withPty(backend, async ({ pty, out, token }) => {
    await initShell(pty, out, token)
    pty.write(`printf 'QN_SIZE1_%s_%s\\n' "$(stty size | tr ' ' x)" "$QN_TOKEN"\n`)
    await out.waitFor((o) => o.plain().includes(`QN_SIZE1_24x80_${token}`), 8000, '初始尺寸')
    const resized = backend === 'python'
      ? waitForControl(pty, (m) => m.type === 'resized', 4000, 'resized')
      : Promise.resolve(null)
    const supported = pty.resize(120, 40)
    const control = await resized
    await sleep(120)
    pty.write(`printf 'QN_SIZE2_%s_%s\\n' "$(stty size | tr ' ' x)" "$QN_TOKEN"\n`)
    const size2Pattern = new RegExp(`QN_SIZE2_(\\d+)x(\\d+)_${token}`)
    await out.waitFor((o) => size2Pattern.test(o.plain()), 8000, 'resize 后 stty size')
    const size2Match = size2Pattern.exec(out.plain())
    const size2 = size2Match ? `${size2Match[1]}x${size2Match[2]}` : null
    const trapLine = `trap 'printf "QN_WINCH_%s\\n" "$QN_TOKEN"' WINCH; printf 'QN_TRAPSET_%s\\n' "$QN_TOKEN"\n`
    pty.write(trapLine)
    await out.waitFor((o) => o.has(marker('QN_TRAPSET', token)), 4000, 'SIGWINCH trap 安装完成')
    const winch = supported
      ? out.waitFor((o) => o.has(marker('QN_WINCH', token)), 5000, 'SIGWINCH trap').then(() => true).catch(() => false)
      : Promise.resolve(false)
    if (supported) {
      pty.resize(100, 30)
      // bash 只在命令边界执行 trap，补一个空行让它有机会处理挂起的信号。
      await sleep(120)
      pty.write('\n')
    }
    return {
      resizeSupported: supported,
      controlAck: control ? control.cols : null,
      sizeAfter: size2,
      sigwinchDelivered: await winch,
    }
  })
}

async function caseExitCode(backend) {
  const pty = spawnPty({
    shell: '/bin/bash',
    args: ['--noprofile', '--norc', '-i'],
    cwd: scratch,
    backend,
    capabilities: caps,
  })
  let exit = null
  pty.onExit((info) => {
    exit = info
  })
  pty.onData(() => {})
  try {
    await pty.waitReady(8000)
    pty.write('exit 7\n')
    const info = await waitForExit(pty, () => exit, 8000)
    return { ...info, okCode: info.code === 7 }
  } finally {
    pty.kill()
  }
}

// ---------- 全屏程序 ----------
function hasAltScreen(out) {
  const bytes = out.raw()
  return bytes.includes(Buffer.from('\u001b[?1049h')) ||
    bytes.includes(Buffer.from('\u001b[?47h')) ||
    bytes.includes(Buffer.from('\u001b[H\u001b[2J'))
}

async function fullScreen(backend, name, command, quitKeys, options = {}) {
  return withPty(backend, async ({ pty, out, token }) => {
    await initShell(pty, out, token)
    const t0 = performance.now()
    pty.write(`${command}\n`)
    await out.waitFor(
      (o) =>
        hasAltScreen(o) ||
        (options.readyMarker ? o.plain().includes(`${options.readyMarker}${token}`) : false),
      10000,
      `${name} 进入全屏`,
    )
    const startupMs = round(performance.now() - t0)
    if (options.resizeTo) {
      const resizedMarker = marker('QN_CURSES_RESIZED', token)
      pty.resize(options.resizeTo.cols, options.resizeTo.rows)
      await out.waitFor((o) => o.has(resizedMarker), 10000, `${name} 收到 KEY_RESIZE`)
    }
    const t1 = performance.now()
    pty.write(quitKeys)
    // 全屏程序退出耗时不定；重复投递标记命令，直到 shell 真正接回输入。
    let quitSeen = false
    for (let attempt = 0; attempt < 20 && !quitSeen; attempt += 1) {
      await sleep(250)
      pty.write(`${doneLine('QN_QUIT')}\n`)
      quitSeen = await out
        .waitFor((o) => o.has(marker('QN_QUIT', token)), 300, `${name} 退出后回到 shell`)
        .then(() => true)
        .catch(() => false)
    }
    if (!quitSeen) throw new Error(`${name} 退出后 5s 内未回到 shell`)
    return {
      altScreen: hasAltScreen(out),
      startupMs,
      quitMs: round(performance.now() - t1),
      outputBytes: out.total,
      ...(options.resizeTo ? { resizeDelivered: out.has(marker('QN_CURSES_RESIZED', token)) } : {}),
    }
  })
}

// ---------- 吞吐与延迟 ----------
async function caseThroughput(backend) {
  return withPty(backend, async ({ pty, out, token }) => {
    await initShell(pty, out, token)
    const t0 = performance.now()
    pty.write(`dd if=/dev/zero bs=1M count=10 2>/dev/null | tr '\\0' 'x'; ${doneLine('QN_BULK')}\n`)
    await out.waitFor((o) => o.has(marker('QN_BULK', token)), 90000, '10MB 输出结束')
    const ms = performance.now() - t0
    return {
      outputBytes: out.total,
      elapsedMs: round(ms),
      mibPerSec: round(10 / (ms / 1000)),
      megabytesPerSec: round((10 * 1024 * 1024) / (ms / 1000) / 1e6),
      frameLimitNote: '单帧上限 16MiB，10MiB 原始字节 base64 后约 13.3MiB，仍在一帧内',
    }
  })
}

async function caseLatency(backend) {
  return withPty(backend, async ({ pty, out, token }) => {
    await initShell(pty, out, token)
    const rtt = []
    for (let i = 0; i < 12; i += 1) {
      const value = 20000 + i
      const t0 = performance.now()
      pty.write(`printf 'QN_PING_%s_%s\\n' "$((20000+${i}))" "$QN_TOKEN"\n`)
      await out.waitFor((o) => o.has(`QN_PING_${value}_${token}`), 5000, `ping ${i}`)
      rtt.push(round(performance.now() - t0))
    }
    const controlRtt = []
    if (pty.ping(0)) {
      for (let i = 1; i <= 8; i += 1) {
        const t0 = performance.now()
        const pong = waitForControl(pty, (m) => m.type === 'pong' && m.id === i, 3000, `pong ${i}`)
        pty.ping(i)
        await pong
        controlRtt.push(round(performance.now() - t0))
      }
    }
    return {
      shellRttMs: rtt,
      shellP50Ms: percentile(rtt, 0.5),
      shellP95Ms: percentile(rtt, 0.95),
      controlRttMs: controlRtt,
      controlP50Ms: controlRtt.length ? percentile(controlRtt, 0.5) : null,
    }
  })
}

// ---------- 探测顺序与明确错误 ----------
async function caseProbeAndFallback(backend) {
  const spawnAndKill = async (preferred) => {
    const pty = spawnPty({
      cwd: scratch,
      backend: preferred,
      capabilities: caps,
      shell: '/bin/bash',
      args: ['--noprofile', '--norc', '-i'],
    })
    pty.onData(() => {})
    let exit = null
    pty.onExit((info) => {
      exit = info
    })
    await pty.waitReady(8000)
    const info = { backend: pty.backend, resize: pty.resize(90, 30) }
    pty.kill()
    await waitForExit(pty, () => exit, 4000).catch(() => pty.kill('SIGKILL'))
    return info
  }
  const auto = await spawnAndKill('auto')
  const forcedScript = await spawnAndKill('script')
  return {
    autoBackend: auto.backend,
    pythonUsable: caps.python3.ok,
    scriptUsable: caps.script.ok,
    scriptResizeReturnsFalse: forcedScript.resize === false,
    bothMissingMessage: '未找到可用的 PTY 后端：需要 python3（pty.fork + fcntl.ioctl）或 util-linux script',
  }
}

const backends = ['python', 'script']
const programCases = [
  ['vim', `vim -u NONE -n ${path.join(scratch, 'sample.txt')}`, '\u001b:q!\r'],
  ['htop', 'htop', 'q'],
  ['less', `less -R ${path.join(scratch, 'sample.txt')}`, 'q'],
  ['vi(vim.tiny)', `vi -u NONE -n ${path.join(scratch, 'sample.txt')}`, '\u001b:q!\r'],
  ['nano', `nano -w ${path.join(scratch, 'sample.txt')}`, '\u0018'],
  ['top', 'top -d 1', 'q'],
  ['python curses', `python3 ${path.join(scratch, 'curses_app.py')}`, 'q'],
]

for (const backend of backends) {
  if (backend === 'python' && !caps.python3.ok) {
    cases.push({ name: 'python 后端全部', backend, ok: false, skipped: true, error: 'python3 不可用' })
    continue
  }
  if (backend === 'script' && !caps.script.ok) {
    cases.push({ name: 'script 后端全部', backend, ok: false, skipped: true, error: 'script 不可用' })
    continue
  }
  await runCase('中文 UTF-8', backend, caseChinese)
  await runCase('Ctrl+C', backend, caseCtrlC)
  await runCase('resize / SIGWINCH', backend, caseResize)
  await runCase('exit 退出码 7', backend, caseExitCode)
  await runCase('10MB 吞吐', backend, caseThroughput)
  await runCase('往返延迟', backend, caseLatency)
  for (const [name, command, quit] of programCases) {
    const tool = name === 'python curses' ? 'python3' : name === 'vi(vim.tiny)' ? 'vi' : name
    if (!tools[tool]) {
      cases.push({ name: `全屏 ${name}`, backend, ok: false, skipped: true, error: `93 未安装 ${tool}（按约束不安装）` })
      continue
    }
    await runCase(`全屏 ${name}`, backend, (b) =>
      fullScreen(b, name, command, quit, {
        readyMarker: name === 'python curses' ? 'QN_CURSES_START_' : undefined,
        resizeTo: name === 'python curses' && b === 'python' ? { cols: 132, rows: 43 } : undefined,
      }),
    )
  }
  if (backend === 'python') {
    await runCase('探测与兜底顺序', backend, caseProbeAndFallback)
  }
}

function round(value) {
  return Math.round(value * 100) / 100
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? null
}

const report = {
  meta,
  cases,
  summary: {
    total: cases.length,
    ok: cases.filter((c) => c.ok).length,
    failed: cases.filter((c) => !c.ok && !c.skipped).length,
    skipped: cases.filter((c) => c.skipped).length,
  },
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
diag(`结束：成功 ${report.summary.ok} / 失败 ${report.summary.failed} / 跳过 ${report.summary.skipped}`)
