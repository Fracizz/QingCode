import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-landscape-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-landscape')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(directory, `${name}.png`))
const collapsed = `document.querySelector('#special-keys').hidden && document.querySelector('#completion-tools').hidden && document.querySelector('#toggle-keys').getAttribute('aria-expanded') === 'false'`
const fullscreen = `window.__mobileFixture.state.fullscreen && document.querySelector('#toggle-fullscreen').getAttribute('aria-pressed') === 'true' && getComputedStyle(document.querySelector('.terminal-head')).display === 'none'`
const fits = `document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('#toggle-keys, #toggle-fullscreen, #compose-form')].every(el => {const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;})`

try {
  run('set', 'viewport', '844', '390')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('landscape defaults to collapsed keys with an accessible expansion control', `typeof window.qingLink === 'function' && ${collapsed}`)
  evaluate(`window.Terminal = class extends window.Terminal { constructor(...args) { super(...args); window.__landscapeTerm = this; } }; window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('computer is connected', `document.querySelector('#active-host').dataset.state === 'online'`)
  run('click', '#dashboard-nav [data-page="project"]')
  run('click', '#project-list .row:first-child')
  check('collapsed landscape leaves at least 200px for terminal output', `document.querySelector('#terminal-status').textContent === '会话中' && document.querySelector('#viewport').getBoundingClientRect().height >= 200 && ${fits}`)
  capture('01-landscape-collapsed')

  run('set', 'viewport', '390', '844')
  check('portrait defaults to expanded keys until a preference is saved', `!document.querySelector('#special-keys').hidden && !document.querySelector('#completion-tools').hidden`)
  run('set', 'viewport', '844', '390')
  check('rotation back to landscape automatically collapses default keys', collapsed)
  run('click', '#toggle-keys')
  check('expanded landscape places completion beside the command bar', `(() => {
    const a = document.querySelector('#completion-tools').getBoundingClientRect();
    const b = document.querySelector('#compose-form').getBoundingClientRect();
    return !document.querySelector('#special-keys').hidden && Math.abs(a.top - b.top) <= 1 && a.right <= b.left && ${fits};
  })()`)
  capture('02-landscape-expanded')
  run('fill', '#compose', '/effort')
  evaluate(`window.__expandedHeight = document.querySelector('#viewport').getBoundingClientRect().height; window.__expandedRows = window.__landscapeTerm.rows`)
  run('click', '#toggle-keys')
  check('collapsing restores terminal rows without losing the draft', `${collapsed} && document.querySelector('#compose').value === '/effort' && document.querySelector('#viewport').getBoundingClientRect().height >= window.__expandedHeight + 40 && window.__landscapeTerm.rows > window.__expandedRows`)
  run('set', 'viewport', '390', '844')
  check('explicit collapsed preference survives rotation', `${collapsed} && localStorage.getItem('qingcode:mobile:keys-collapsed') === 'true'`)
  run('set', 'viewport', '844', '390')
  run('click', '#toggle-keys')
  run('click', '#special-keys [data-key="ctrl"]')
  run('click', '#toggle-keys')
  check('collapsing keeps the real-time keyboard and releases hidden modifiers', `${collapsed} && document.activeElement === window.__landscapeTerm.textarea && document.querySelector('#special-keys [data-key="ctrl"]').getAttribute('aria-pressed') === 'false'`)

  evaluate(`window.__normalHeight = document.querySelector('#viewport').getBoundingClientRect().height; window.__sessionCount = window.__mobileFixture.state.sessions.size`)
  run('click', '#toggle-fullscreen')
  check('fullscreen uses the native bridge and releases application header height', `${fullscreen} && document.querySelector('#viewport').getBoundingClientRect().height >= window.__normalHeight + 40 && ${fits}`)
  check('fullscreen preserves the current session and unsent text', `window.__mobileFixture.state.sessions.size === window.__sessionCount && document.querySelector('#compose').value === '/effort' && document.activeElement === window.__landscapeTerm.textarea`)
  capture('03-landscape-fullscreen')
  run('set', 'viewport', '844', '230')
  check('fullscreen remains usable above a landscape soft keyboard', `${fullscreen} && document.querySelector('#viewport').getBoundingClientRect().height >= 100 && ${fits}`)
  capture('04-landscape-keyboard')
  run('set', 'viewport', '390', '844')
  check('fullscreen and collapsed preference survive orientation changes', `${fullscreen} && ${collapsed} && ${fits}`)
  run('set', 'viewport', '844', '390')
  evaluate('window.qingBack()')
  check('Android Back exits fullscreen before leaving the terminal', `!window.__mobileFixture.state.fullscreen && !document.querySelector('#terminal-screen').hidden && document.querySelector('#toggle-fullscreen').getAttribute('aria-pressed') === 'false' && getComputedStyle(document.querySelector('.terminal-head')).display !== 'none'`)

  evaluate(`window.__mobileFixture.state.fullscreenError = '模拟全屏切换失败'`)
  run('click', '#toggle-fullscreen')
  check('native fullscreen failure restores the normal UI', `document.querySelector('#terminal-screen').dataset.fullscreen === 'false' && document.querySelector('#terminal-status').textContent === '模拟全屏切换失败'`)
  evaluate(`window.__mobileFixture.state.fullscreenError = null`)
  run('click', '#toggle-fullscreen')
  check('fullscreen can be retried after a native failure', fullscreen)
  run('click', '#toggle-fullscreen')
  check('fullscreen exit button is always accessible with collapsed keys', `!window.__mobileFixture.state.fullscreen && ${collapsed} && ${fits}`)

  // Delay one old reply to ensure it cannot overwrite a newer exit request.
  evaluate(`window.__nativeRequest = window.QingCodeNative.request; window.QingCodeNative.request = (id, payload) => {
    const r = JSON.parse(payload);
    if (r.op === 'fullscreen' && r.enabled) { window.__delayedFullscreenReply = () => window.qingReply(id, {ok:true, data:true}); return; }
    window.__nativeRequest(id, payload);
  }`)
  run('click', '#toggle-fullscreen')
  evaluate(`window.qingBack(); window.__delayedFullscreenReply(); window.QingCodeNative.request = window.__nativeRequest`)
  check('a late fullscreen reply cannot undo a newer exit', `document.querySelector('#terminal-screen').dataset.fullscreen === 'false' && !window.__mobileFixture.state.fullscreen`)
  evaluate('window.qingBack()')
  check('leaving the terminal retains dashboard system bars', `document.querySelector('#terminal-screen').hidden && !document.querySelector('#dashboard').hidden && !window.__mobileFixture.state.fullscreen`)
  run('reload')
  check('saved shortcut preference survives a page reload', `typeof window.qingBack === 'function' && ${collapsed}`)
  const errors = JSON.parse(run('errors', '--json'))
  if (errors.data?.errors?.length) throw new Error(JSON.stringify(errors.data.errors))
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure') } catch { /* Preserve the original failure. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  writeFileSync(resolve(directory, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机横屏与全屏验收</title><h1>手机横屏与全屏验收</h1><p>真实 Web 资产和 xterm、模拟原生桥；不含真机系统栏、挖孔和输入法验收。</p><ul>${results.map(item => `<li>${item.passed ? '通过' : '失败'}：${escape(item.name)}</li>`).join('')}</ul></html>`)
  try { run('close') } catch { /* Browser may already be closed. */ }
}
console.log(`${results.filter(item => item.passed).length}/${results.length} browser checks passed. ${directory}`)
