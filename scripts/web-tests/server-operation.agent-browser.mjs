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
