import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-nav-top-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-nav-top')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const nav = page => `#dashboard-nav [data-page="${page}"]`
const scrolled = page => `document.getElementById('${page}-screen').scrollTop > 200`
const atTop = page => `document.getElementById('${page}-screen').scrollTop === 0`
const scroll = page => evaluate(`document.getElementById('${page}-screen').scrollTop = 500`)

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('mobile fixture is ready', `typeof window.qingLink === 'function'`)
  // Supply enough content to scroll every real dashboard page without native/network dependencies.
  evaluate(`for (const page of document.querySelectorAll('.dashboard-page')) {
    const content = document.createElement('div');
    content.style.height = '1600px';
    content.textContent = '滚动内容';
    page.append(content);
  }`)

  for (const page of ['home', 'project', 'connection']) {
    run('click', nav(page))
    check(`${page}: a single tap selects the page`, `!document.getElementById('${page}-screen').hidden`)
    scroll(page)
    check(`${page}: content can scroll`, scrolled(page))
    run('wait', '350')
    run('click', nav(page))
    check(`${page}: a single tap preserves the scroll position`, scrolled(page))
    evaluate('window.__hapticsBeforeTap = window.__mobileFixture.state.haptics ?? 0')
    run('wait', '350')
    run('dblclick', nav(page))
    check(`${page}: double-tap provides visible feedback and one haptic`, `!document.getElementById('sort-toast').hidden && document.getElementById('sort-toast').textContent === '已回到顶部' && window.__mobileFixture.state.haptics === window.__hapticsBeforeTap + 1`)
    if (page === 'connection') run('screenshot', resolve(directory, 'connection-feedback.png'))
    check(`${page}: double-click scrolls to the top`, atTop(page))
  }
  run('screenshot', resolve(directory, 'connection-top.png'))
  run('dblclick', nav('connection'))
  check('double-tap at the top still provides feedback', `!document.getElementById('sort-toast').hidden && document.getElementById('sort-toast').textContent === '已在顶部'`)
  check('feedback automatically dismisses', `document.getElementById('sort-toast').hidden`)

  // Android touch-generated clicks may all have detail=1. Use timestamps to exercise
  // touch compatibility and the timeout without relying on CLI process startup speed.
  evaluate(`window.__navTap = (page, time) => {
    const event = new MouseEvent('click', { bubbles: true, detail: 1 });
    Object.defineProperty(event, 'timeStamp', { value: time });
    document.querySelector('#dashboard-nav [data-page="' + page + '"]').dispatchEvent(event);
  }`)
  scroll('connection')
  evaluate(`const now = performance.now() + 1000; window.__navNow = now;
    window.__navTap('connection', now); window.__navTap('connection', now + 301)`)
  check('taps more than 300ms apart preserve scroll', scrolled('connection'))
  evaluate(`window.__navTap('connection', window.__navNow + 601)`)
  check('touch-style clicks at the 300ms boundary return to the top', atTop('connection'))

  scroll('connection')
  evaluate(`window.__navTap('home', window.__navNow + 1000); window.__navTap('connection', window.__navNow + 1100)`)
  check('quick taps on different tabs do not reset their scroll', scrolled('connection'))

  run('set', 'media', 'dark', 'reduced-motion')
  evaluate(`window.__navTap('connection', window.__navNow + 1300)`)
  assert.equal(evaluate(atTop('connection')).trim(), 'true')
  results.push({ name: 'reduced motion returns to the top immediately', passed: true })
  evaluate(`(async () => { await import('/mobile-android/i18n.js').then(module => module.setLocale('en'));
    window.__navTap('connection', window.__navNow + 2000); window.__navTap('connection', window.__navNow + 2100); })()`)
  check('feedback is translated into English', `document.getElementById('sort-toast').textContent === 'Already at the top'`)
  const errors = JSON.parse(run('errors', '--json'))
  assert.deepEqual(errors.data?.errors ?? [], [])
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { run('screenshot', resolve(directory, 'failure.png')) } catch { /* Keep the original failure. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  try { run('close') } catch { /* Browser may already be closed. */ }
}
console.log(`${results.filter(result => result.passed).length}/${results.length} browser checks passed. ${directory}`)
