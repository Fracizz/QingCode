import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = 'mobile-shared-view-' + process.pid
const output = resolve('.dev/web-tests/mobile-shared-view')
mkdirSync(output, { recursive: true })
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push(name)
}
const results = []
try {
  run('set', 'viewport', '390', '844')
  run('open', (process.env.WEB_TEST_BASE ?? 'http://127.0.0.1:38439') + '/mobile-android/')
  run('wait', '--fn', "typeof window.qingLink === 'function'")
  evaluate(`window.f = window.__mobileFixture; window.s = f.state;
    s.capabilities.features.push('handoff', 'shared_view');
    f.addDesktopTerminal({id:'term-9', project:'p-ssh', title:'shared'});
    window.qingLink(f.link('192.168.1.8', 48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  run('wait', '--fn', "document.querySelector('#active-host').dataset.state === 'online'")
  run('click', '#dashboard-nav [data-page="home"]')
  run('wait', '#home-session-overview [data-id="term-9"] .row')
  run('click', '#home-session-overview [data-id="term-9"] .row')
  check('打开电脑终端默认旁观', "document.querySelector('#terminal-taken-text').textContent.includes('电脑') && s.attaches.at(-1).take === false")
  evaluate("f.pushScreen('term-9','windows-first-frame')")
  check('显示 Windows 输出', "f.terminalText().includes('windows-first-frame')")
  check('竖屏完整显示主控网格', "document.querySelector('.xterm-screen').getBoundingClientRect().right <= innerWidth")
  run('screenshot', resolve(output, 'phone.png'))
  run('click', '#terminal-menu')
  run('wait', '--fn', "document.querySelector('#terminal-menu-dialog').open && !document.querySelector('#terminal-menu-dialog').getAnimations().some(a => a.playState === 'running')")
  run('click', '#menu-read')
  run('wait', '--fn', "document.querySelector('#reader-dialog').open && !document.querySelector('#reader-dialog').getAnimations().some(a => a.playState === 'running')")
  run('fill', '#reader-query', 'windows')
  check('旁观端可独立搜索', "document.querySelector('#reader-content mark')?.textContent === 'windows' && s.inputs.length === 0")
  run('click', '#reader-copy')
  check('只读复制保留主控', "s.clipboard.includes('windows-first-frame') && s.sessions.get('term-9').holder === '电脑'")
  evaluate("f.pushScreen('term-9','next-windows-frame')")
  check('阅读时终端继续更新', "f.terminalText().includes('next-windows-frame') && document.querySelector('#reader-content').textContent.includes('windows-first-frame')")
  run('click', '[data-close="reader-dialog"]')
  run('set', 'viewport', '844', '390')
  run('wait', '300')
  check('旁观者横屏仍保留主控网格', "f.terminalSize().cols === 80 && f.terminalSize().rows === 24 && s.resizes.length === 0")
  evaluate("f.terminal().input('ignored',true)")
  run('wait', '100')
  assert.equal(evaluate('s.inputs.length').trim(), '0')
  run('screenshot', resolve(output, 'viewer.png'))
  run('click', '#terminal-take-back')
  check('显式接管后可输入', "s.attaches.at(-1).take && !document.querySelector('#send').disabled && s.resizes.length > 0")
  run('fill', '#compose', 'echo shared')
  run('click', '#send')
  check('主控输入带使用权编号', "s.inputs.join('').includes('echo shared') && s.leasedInputs.at(-1) === s.sessions.get('term-9').lease")
  evaluate("f.takeOver('term-9','平板'); f.pushScreen('term-9','tablet-has-control')")
  check('平板接管，原端继续看', "document.querySelector('#terminal-taken-text').textContent.includes('平板') && f.terminalText().includes('tablet-has-control') && document.querySelector('#send').disabled")
  evaluate("f.takeOver('term-9','电脑'); f.pushScreen('term-9','windows-again')")
  check('Windows 接回后画面继续刷新', "document.querySelector('#terminal-taken-text').textContent.includes('电脑') && f.terminalText().includes('windows-again')")
  evaluate("s.pollErrors = 1")
  run('wait', '--fn', 's.attaches.length >= 3')
  check('重连保留主控', "s.attaches.at(-1).take === false && s.sessions.get('term-9').holder === '电脑' && document.querySelector('#terminal-dot').dataset.state === 'online'")
  assert.deepEqual(JSON.parse(run('errors', '--json')).data?.errors ?? [], [])
  console.log(results)
} catch (error) {
  console.error(evaluate(`({page: document.querySelector('#dashboard-nav [aria-current=page]')?.dataset.page,
    status: document.querySelector('#terminal-status').textContent, requests: s.sessionRequests.slice(-3),
    attaches: s.attaches, cols: f.terminalSize(), polls: s.polls.slice(-2), body: document.body.innerText.slice(0,300)})`))
  throw error
} finally {
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, passed: results }, null, 2))
  run('close')
}
