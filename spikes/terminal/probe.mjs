import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { parsePythonProbe, parseScriptProbe } from './control.mjs'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

// -I 隔离掉 PYTHONPATH 等环境变量；只依赖标准库，不读当前目录。
export const PYTHON_PROBE_SOURCE = [
  'import json, os, sys, pty, fcntl, termios, select, signal, struct',
  'print(json.dumps({',
  '  "ok": os.name == "posix" and hasattr(pty, "fork") and hasattr(termios, "TIOCSWINSZ"),',
  '  "pty": hasattr(pty, "fork"),',
  '  "version": ".".join(map(str, sys.version_info[:3])),',
  '  "platform": sys.platform,',
  '}))',
].join('\n')

/**
 * @typedef {{ ok: boolean, version?: string, detail?: string }} ProbeResult
 * @typedef {{ python3: ProbeResult, script: ProbeResult, posix: boolean, pythonVersion: string, scriptVersion: string }} Capabilities
 */

/** @param {string} err */
function resultOrEmpty(err) {
  return {
    python3: { ok: false, version: '', detail: `python3 不可用: ${err}` },
    script: { ok: false, version: '', detail: `script 不可用: ${err}` },
    posix: true,
    pythonVersion: '',
    scriptVersion: '',
  }
}

/** 同步探测，spawnPty 用它决定后端；探测结果可由调用方注入以便测试。 */
export function probeSync() {
  const posix = process.platform !== 'win32'
  if (!posix) {
    return {
      python3: { ok: false, version: '', detail: 'Windows 没有 pty.fork / TIOCSWINSZ' },
      script: { ok: false, version: '', detail: 'Windows 没有 util-linux script' },
      posix,
      pythonVersion: '',
      scriptVersion: '',
    }
  }
  const py = spawnSync('python3', ['-I', '-c', PYTHON_PROBE_SOURCE], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  })
  const python3 = py.error
    ? { ok: false, version: '', detail: String(py.error) }
    : parsePythonProbe(py.status === 0 ? (py.stdout ?? '') : '')
  const ver = spawnSync('script', ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
  const help = spawnSync('script', ['--help'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
  const script =
    ver.error || help.error
      ? { ok: false, version: '', detail: String(ver.error ?? help.error) }
      : parseScriptProbe(ver.status === 0 ? (ver.stdout ?? '') : '', help.status === 0 ? (help.stdout ?? '') : '')
  return {
    python3,
    script,
    posix,
    pythonVersion: python3.version ?? '',
    scriptVersion: script.version ?? '',
  }
}

/** 异步版本：给需要与其他启动逻辑并发的调用方。 */
export async function detectCapabilities() {
  const posix = process.platform !== 'win32'
  if (!posix) return probeSync()
  try {
    const [py, ver, help] = await Promise.all([
      execFileAsync('python3', ['-I', '-c', PYTHON_PROBE_SOURCE], { timeout: PROBE_TIMEOUT_MS }),
      execFileAsync('script', ['--version'], { timeout: PROBE_TIMEOUT_MS }),
      execFileAsync('script', ['--help'], { timeout: PROBE_TIMEOUT_MS }),
    ])
    const python3 = parsePythonProbe(py.stdout)
    const script = parseScriptProbe(ver.stdout, help.stdout)
    return {
      python3,
      script,
      posix,
      pythonVersion: python3.version,
      scriptVersion: script.version,
    }
  } catch (cause) {
    return resultOrEmpty(String(cause))
  }
}
