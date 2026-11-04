import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-settings-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-connection')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const check = (name, expression) => { run('wait', '--fn', expression); results.push({ name, passed: true }) }
const capture = name => run('screenshot', '.mobile-connection-settings', resolve(directory, `${name}.png`))
const field = `document.querySelector('#mobile-connection-password')`
const pairingLayout = `(() => {
  const body = document.querySelector('.mobile-connection-body').getBoundingClientRect();
  const cards = [...document.querySelector('.mobile-connection-body').children].map(node => node.getBoundingClientRect());
  const pairing = document.querySelector('.mobile-connection-pairing');
  const text = pairing.querySelector('ol').getBoundingClientRect();
  const select = pairing.querySelector('select').getBoundingClientRect();
  const content = document.querySelector('.mobile-connection-settings .settings-item-control').getBoundingClientRect();
  return cards.length === 2 && body.width >= content.width - 1 &&
    cards.every(card => card.left >= body.left && card.right <= body.right + 1) &&
    text.width >= Math.min(200, body.width - 50) && select.right <= cards[1].right &&
    document.documentElement.scrollWidth <= innerWidth;
})()`
const aligned = `(() => {
  const port = document.querySelector('#mobile-connection-port').getBoundingClientRect();
  const password = ${field}.getBoundingClientRect();
  const titles = [...document.querySelectorAll('.settings-item-copy > div')].map(node => node.getBoundingClientRect());
  return Math.abs(port.left - password.left) < 1 && Math.abs(port.height - password.height) < 1 &&
    Math.abs(titles[0].left - titles[1].left) < 1 && document.documentElement.scrollWidth <= innerWidth;
})()`

try {
  run('set', 'viewport', '1100', '800')
  run('open', 'http://127.0.0.1:38439/web-tests/mobile-connection.html')
  check('settings and field controls align', `${field} && !${field}.disabled && ${aligned}`)
  click('保存并启用')
  check('empty password reports the new length rule', `document.querySelector('[role="alert"]').textContent.includes('6–20 位密码')`)
  run('fill', '#mobile-connection-password', '123456')
  click('显示密码')
  check('password can be shown before saving', `${field}.type === 'text' && ${field}.value === '123456'`)
  capture('settings-dark')
  click('保存并启用')
  check('simple numeric password is saved and still visible while active', `${field}.disabled && ${field}.value === '123456' && document.body.textContent.includes('已保存并启用')`)
  check('wide settings use the full content width and readable pairing steps', `document.querySelector('[aria-label="Android 配对二维码"]') && ${pairingLayout}`)
  capture('pairing-wide-dark')
  run('select', '[aria-label="配对使用的电脑地址"]', '10.0.0.5')
  check('address selection still updates the pairing link', `document.querySelector('[aria-label="配对使用的电脑地址"]').value === '10.0.0.5'`)
  run('click', '.mobile-connection-pairing summary')
  check('certificate details remain available on demand', `document.querySelector('.mobile-connection-pairing details').open`)
  run('eval', `document.querySelector('.settings-shell').style.maxWidth = '560px'`)
  check('split editor follows its own width inside a wide window', `${pairingLayout} && (() => {
    const cards = document.querySelector('.mobile-connection-body').children;
    return cards[1].getBoundingClientRect().top >= cards[0].getBoundingClientRect().bottom;
  })()`)
  capture('pairing-split-dark')
  run('eval', `document.querySelector('.settings-shell').style.maxWidth = ''`)
  run('set', 'viewport', '800', '1000')
  check('medium settings stack the form above pairing', `${pairingLayout} && (() => {
    const cards = document.querySelector('.mobile-connection-body').children;
    return cards[1].getBoundingClientRect().top >= cards[0].getBoundingClientRect().bottom;
  })()`)
  capture('pairing-medium-dark')
  run('set', 'viewport', '1100', '800')
  click('重新打开设置')
  check('reopening restores the password masked by default', `${field}.disabled && ${field}.value === '123456' && ${field}.type === 'password'`)
  click('显示密码')
  check('saved password can be revealed', `${field}.type === 'text' && ${field}.value === '123456'`)
  click('停止连接')
  check('stopping retains the saved password for editing', `!${field}.disabled && ${field}.value === '123456'`)
  run('fill', '#mobile-connection-password', 'abcdefghijklmnopqrst')
  click('保存并启用')
  check('20 letter password is accepted without digits', `${field}.disabled && ${field}.value === 'abcdefghijklmnopqrst'`)
  click('停止连接')
  run('fill', '#mobile-connection-password', '12345')
  click('保存并启用')
  check('short password is rejected', `document.querySelector('[role="alert"]').textContent.includes('6–20 位密码') && !${field}.disabled`)
  run('fill', '#mobile-connection-password', 'abcdef')
  run('set', 'viewport', '390', '780')
  click('切换主题')
  check('light narrow controls remain aligned', aligned)
  capture('settings-light-narrow')
  click('放大字号')
  check('large interface font preserves alignment', aligned)
  capture('settings-large-font')
  click('保存并启用')
  check('large font narrow pairing keeps text and address within the card', `document.querySelector('[aria-label="Android 配对二维码"]') && ${pairingLayout}`)
  capture('pairing-narrow-large-font')
  run('set', 'viewport', '1100', '1000')
  check('large font wide settings avoid squeezing pairing steps', pairingLayout)
  capture('pairing-wide-large-font')
} catch (error) {
  results.push({ name: String(error), passed: false })
  capture('failure')
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  writeFileSync(resolve(directory, 'browser-errors.json'), run('errors', '--json'))
  run('close')
}
console.log(`${results.filter(result => result.passed).length}/${results.length} browser checks passed. ${directory}`)
