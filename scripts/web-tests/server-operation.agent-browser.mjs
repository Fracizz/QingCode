import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `server-operation-${process.pid}`
const directory = resolve('.dev/web-tests/server-operation')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const check = (name, condition) => {
  run('wait', '--fn', condition)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', '.server-operation-card', resolve(directory, `${name}.png`))
const captureStack = name => run('screenshot', '[data-floating-task-stack]', resolve(directory, `${name}.png`))
const separateCards = `(() => {
  const stack = document.querySelector('[data-floating-task-stack]');
  const cards = [...stack.children].map(card => card.getBoundingClientRect());
  return cards.every((card, i) => card.width > 0 && card.left >= 0 && card.right <= innerWidth &&
    (i === 0 || card.top >= cards[i - 1].bottom + 7));
})()`
try {
  run('set', 'viewport', '1200', '800')
  run('open', 'http://127.0.0.1:38439/web-tests/server-operation.html')
  click('模拟首次安装')
  check('first installation stays nonmodal with four real stages', `!document.querySelector('[role="dialog"]') && document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuemax') === '4'`)
  click('安装第 3 步')
  check('installation card follows the native installing phase', `document.querySelector('[role="status"]').textContent.includes('安装 QingCode Server') && document.body.textContent.includes('第 3/4 步')`)
  capture('install-dark')
  click('验证第 4 步')
  check('file verification advances the stage', `document.body.textContent.includes('第 4/4 步')`)
  click('取消打开')
  check('cancel opening closes its card', `!document.querySelector('.server-operation-card')`)
  click('模拟后台更新')
  click('更新第 3 步')
  check('background update displays real upload progress', `document.querySelector('.server-operation-card').textContent.includes('更新中') && document.body.textContent.includes('第 3/4 步')`)
  check('elapsed seconds advance independently of stage progress', `/已用 [1-9][0-9]* 秒/.test(document.querySelector('.server-operation-card').textContent)`)
  capture('update-dark')
  click('添加并行更新')
  check('parallel updates share a stack without overlap', `document.querySelectorAll('.server-operation-card').length === 2 && ${separateCards}`)
  captureStack('parallel-updates-dark')
  click('并行打开项目')
  check('opening another project stacks with both updates', `document.querySelectorAll('.server-operation-card').length === 3 && ${separateCards}`)
  click('添加通知与传输')
  check('notifications and transfers also share the stack', `document.querySelector('[data-floating-task-stack]').children.length === 5 && ${separateCards}`)
  captureStack('parallel-mixed-dark')
  click('取消打开')
  check('cancelling opening keeps both background updates', `document.querySelectorAll('.server-operation-card').length === 2 && ${separateCards}`)
  run('reload')
  click('模拟后台更新')
  click('更新第 4 步')
  click('模拟成功')
  check('success shows a completed bar', `document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '4' && document.querySelector('[role="status"]').textContent.includes('Server 已就绪')`)
  run('wait', '--fn', `!document.querySelector('.server-operation-card')`)
  click('模拟后台更新')
  click('模拟失败')
  check('failure preserves actionable details', `document.querySelector('[role="alert"]').textContent.includes('SSH authentication failed')`)
  capture('update-failed')
  click('更新远端服务')
  check('authorization action targets the failing project', `document.querySelector('[data-testid="manual-update-root"]').textContent.includes('ssh://operation/')`)
  run('reload')
  click('模拟后台更新')
  click('切换语言主题')
  run('set', 'viewport', '420', '800')
  check('English light card stays within the narrow viewport', `document.querySelector('.server-operation-card').textContent.includes('Updating') && document.querySelector('.server-operation-card').textContent.includes('Step 2/4') && document.documentElement.scrollWidth <= innerWidth`)
  capture('update-light-en-narrow')
  click('添加并行更新')
  click('并行打开项目')
  check('English light parallel cards stay separate at 420px', `document.querySelectorAll('.server-operation-card').length === 3 && ${separateCards}`)
  captureStack('parallel-light-en-narrow')
  click('添加多条更新')
  run('set', 'viewport', '420', '420')
  check('many parallel tasks scroll within a short viewport', `(() => {
    const stack = document.querySelector('[data-floating-task-stack]');
    const rect = stack.getBoundingClientRect();
    return stack.scrollHeight > stack.clientHeight && rect.top >= 0 && rect.bottom <= innerHeight - 24 &&
      document.documentElement.scrollWidth <= innerWidth && ${separateCards};
  })()`)
  run('eval', `document.querySelector('[data-floating-task-stack]').scrollTop = 100000`)
  check('last task actions remain reachable by scrolling', `(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel opening');
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight - 24;
  })()`)
  captureStack('parallel-short-scrolled')
} catch (error) {
  results.push({ name: String(error), passed: false })
  capture('failure')
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  writeFileSync(resolve(directory, 'browser-errors.json'), run('errors', '--json'))
  run('close')
}
console.log(`${results.filter(r => r.passed).length}/${results.length} browser checks passed. ${directory}`)
