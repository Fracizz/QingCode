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
  check('opening card identifies its remote connection', `document.querySelector('.server-operation-card [data-project-source]')?.textContent === 'windev'`)
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
  const summary = 'button[aria-expanded]'
  const summaryHas = text => `document.querySelector('${summary}')?.textContent.includes('${text}')`
  check('parallel updates collapse to one detail', `${summaryHas('远程任务 2')} && document.querySelectorAll('.server-operation-card').length === 1`)
  captureStack('parallel-updates-dark')
  click('并行打开项目')
  check('latest opening leads the mixed stack', `${summaryHas('远程任务 3')} && document.querySelector('.server-operation-card [data-project-source]').textContent === 'opening'`)
  captureStack('three-tasks-collapsed-dark')
  click('添加通知与传输')
  check('notifications and transfers remain independent', `document.querySelector('[data-floating-task-stack]').children.length === 3 && ${separateCards}`)
  run('click', summary)
  check('expanded rows identify the connections', `document.querySelector('ul[aria-label="远程任务"]').innerText.includes('Linux 开发机')`)
  captureStack('parallel-mixed-dark')
  click('取消打开')
  check('cancel keeps both updates', summaryHas('远程任务 2'))
  click('模拟失败')
  click('1 项需处理')
  check('attention shortcut selects the failed update', `document.querySelector('[role="alert"]')?.textContent.includes('SSH authentication failed')`)
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
  capture('update-background-action')
  click('后台运行')
  check('run in background hides the update card', `!document.querySelector('.server-operation-card')`)
  click('模拟失败')
  check('hidden update reappears when it fails', `document.querySelector('[role="alert"]')?.textContent.includes('SSH authentication failed')`)
  run('reload')
  click('模拟后台更新')
  click('切换语言主题')
  run('set', 'viewport', '420', '800')
  check('English light card stays within the narrow viewport', `document.querySelector('.server-operation-card').textContent.includes('Updating') && document.querySelector('.server-operation-card').textContent.includes('Step 2/4') && document.documentElement.scrollWidth <= innerWidth`)
  check('connection name remains visible in the narrow English card', `(() => { const badge = document.querySelector('[data-project-source]'); const rect = badge.getBoundingClientRect(); return badge.textContent === 'windev' && badge.scrollWidth <= badge.clientWidth && rect.left >= 0 && rect.right <= innerWidth; })()`)
  capture('update-light-en-narrow')
  click('添加并行更新')
  click('并行打开项目')
  check('English summary counts all tasks at 420px', summaryHas('Remote tasks 3'))
  captureStack('parallel-light-en-narrow')
  run('set', 'viewport', '1200', '800')
  click('添加多条更新')
  run('set', 'viewport', '420', '420')
  run('click', summary)
  const rows = 'ul[aria-label="Remote tasks"]'
  check('nine tasks scroll inside the connection list', `(() => {
    const list = document.querySelector('${rows}');
    return list.children.length === 9 && list.scrollHeight > list.clientHeight && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  run('eval', `document.querySelector('${rows}').scrollTop = document.querySelector('${rows}').scrollHeight`)
  run('click', rows + ' li:last-child button')
  check('last connection can be selected', `document.querySelector('.server-operation-card').textContent.includes('并行更新项目-5')`)
  captureStack('parallel-short-scrolled')
  click('Run all in background')
  check('all running tasks leave the foreground', `!document.querySelector('.server-operation-card')`)
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
