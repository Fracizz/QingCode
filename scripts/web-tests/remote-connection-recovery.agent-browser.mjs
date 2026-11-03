import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `remote-recovery-${process.pid}`
const dir = resolve('.dev/web-tests/remote-connection-recovery')
mkdirSync(dir, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const external = name => run('eval', `[...document.querySelectorAll('main button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(dir, `${name}.png`))
try {
  run('set', 'viewport', '1440', '1000')
  run('open', 'http://127.0.0.1:38439/web-tests/remote-connections.html')
  run('wait', 'button[aria-current="true"]')
  external('模拟 WSL 使用 Server')
  check('direct connection exposes SSH recovery without opening configuration', `!!document.querySelector('[aria-label="切换连接方式"] select') && document.body.textContent.includes('root@localhost:22')`)
  run('select', '[aria-label="切换连接方式"] select', 'ssh')
  click('切换到 SSH')
  check('switch confirmation names the SSH target and compatibility mode', `document.body.textContent.includes('终端连接会中断') && [...document.querySelectorAll('[role="dialog"]')].some(d => d.textContent.includes('root@localhost:22') && d.textContent.includes('SSH 直连（兼容模式）'))`)
  capture('switch-confirmation')
  click('取消')
  check('cancelling keeps Server mode', `document.querySelector('[aria-label="切换连接方式"] select').value === 'ssh' && [...document.querySelectorAll('button')].some(b => b.textContent === '断开连接')`)
  external('模拟端口关闭')
  check('polling detects a closed port without a native state event', `document.body.textContent.includes('Fixture port closed') && document.querySelector('.status-connection').dataset.tone === 'offline' && ![...document.querySelectorAll('button')].some(b => b.textContent === '断开连接')`)
  capture('port-closed-dark')
  click('关闭')
  external('切换主题')
  external('切换语言')
  click('打开远程连接')
  run('set', 'viewport', '800', '900')
  check('English light recovery stays within a narrow dialog', `document.body.textContent.includes('Port unavailable? Use SSH') && document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[role="dialog"], section, aside')].every(e => e.scrollWidth <= e.clientWidth + 1)`)
  capture('port-closed-light-en-narrow')

  // Reload resets only fixture state and exercises an explicit native disconnect.
  run('open', 'http://127.0.0.1:38439/web-tests/remote-connections.html')
  run('set', 'viewport', '1440', '1000')
  run('wait', 'button[aria-current="true"]')
  external('模拟 WSL 使用 Server')
  check('fixture returns to a connected Server', `!!document.querySelector('[aria-label="切换连接方式"]') && [...document.querySelectorAll('button')].some(b => b.textContent === '断开连接')`)
  click('断开连接')
  click('断开')
  check('explicit disconnect updates the overview and status bar together', `document.querySelector('.status-connection').dataset.tone === 'offline' && ![...document.querySelectorAll('button')].some(b => b.textContent === '断开连接') && !!document.querySelector('[aria-label="切换连接方式"]')`)
  capture('disconnected-dark')
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure') } catch { /* Navigation may have failed before a page existed. */ }
  try { writeFileSync(resolve(dir, 'failure-snapshot.txt'), run('snapshot', '-i')) } catch { /* No active page. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  try { writeFileSync(resolve(dir, 'browser-errors.json'), run('errors', '--json')) } catch { /* No active page. */ }
  try { run('close') } catch { /* The browser may already be closed. */ }
}
console.log(`${results.filter(r => r.passed).length}/${results.length} browser checks passed. ${dir}`)
