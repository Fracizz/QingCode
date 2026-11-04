import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `connection-latency-${process.pid}`
const dir = resolve('.dev/web-tests/connection-latency')
mkdirSync(dir, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 45000 })
const external = name => run('eval', `[...document.querySelectorAll('main button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(dir, `${name}.png`))
const visibility = state => run('eval', `Object.defineProperty(document, 'visibilityState', { configurable: true, value: '${state}' }); document.dispatchEvent(new Event('visibilitychange'))`)
const countExpression = `JSON.parse(document.querySelector('[data-testid="operation-log"]').textContent).filter(o => o.action === 'latency').length`
try {
  run('set', 'viewport', '1280', '800')
  run('open', 'http://127.0.0.1:38439/web-tests/remote-connections.html')
  run('wait', 'button[aria-current="true"]')
  external('模拟 WSL 使用 Server')
  run('find', 'role', 'button', 'click', '--name', '关闭', '--exact')
  check('ready Server displays plain latency text without an added icon', `document.querySelector('.status-connection')?.textContent.includes('Server 端口直连28 ms') && !document.querySelector('.status-connection svg')`)
  check('accessible tooltip explains round trip, measurement time and interval', `['往返延迟：28 ms', '测量时间：', '每 30 秒更新'].every(s => document.querySelector('.status-connection').getAttribute('aria-label').includes(s))`)
  run('eval', `window.initialLatencyCount = ${countExpression}`)
  run('wait', '5000')
  check('five-second status polling does not repeat latency measurement', `${countExpression} === window.initialLatencyCount`)
  capture('connected-dark')
  visibility('hidden')
  run('wait', '31000')
  check('hidden window skips the next thirty-second sample', `${countExpression} === window.initialLatencyCount`)
  visibility('visible')
  check('restoring visibility immediately measures again', `${countExpression} === window.initialLatencyCount + 1`)
  external('模拟延迟超时')
  visibility('visible')
  check('failed measurement shows a placeholder and keeps ready status', `document.querySelector('.status-connection')?.textContent.includes('-- ms') && document.querySelector('.status-connection').dataset.tone === 'agent'`)
  capture('timeout-dark')
  external('恢复延迟测量')
  visibility('visible')
  check('successful measurement replaces the placeholder', `document.querySelector('.status-connection')?.textContent.includes('28 ms')`)
  external('切换主题')
  external('切换语言')
  run('set', 'viewport', '480', '800')
  check('English light layout stays within a narrow window', `document.querySelector('.status-connection')?.textContent.includes('Server direct connection28 ms') && document.documentElement.scrollWidth <= innerWidth`)
  capture('connected-light-en-narrow')
  external('模拟端口关闭')
  check('disconnected state removes latency', `document.querySelector('.status-connection')?.dataset.tone === 'offline' && !document.querySelector('.status-connection').textContent.includes('ms')`)
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure') } catch { /* No page after navigation failure. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  try { writeFileSync(resolve(dir, 'browser-errors.json'), run('errors', '--json')) } catch { /* No page. */ }
  try { run('close') } catch { /* Browser already closed. */ }
}
console.log(`${results.filter(result => result.passed).length}/${results.length} browser checks passed. ${dir}`)
