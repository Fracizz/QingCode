import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `update-package-${process.pid}`
const artifactDir = resolve('.dev/web-tests/direct-update-source')
mkdirSync(artifactDir, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const check = (name, condition) => {
  run('wait', '--fn', condition)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(artifactDir, `${name}.png`))
const evaluate = source => run('eval', source)
const setScenario = value => evaluate(`(() => { const select = document.querySelector('[aria-label="模拟服务包"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
const setSource = value => evaluate(`(() => { const select = [...document.querySelectorAll('select')].find(el => el.closest('label')?.textContent.includes('服务包来源')); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
const fixtureClick = name => evaluate(`[...document.querySelectorAll('main button')].find(button => button.textContent.trim() === ${JSON.stringify(name)}).click()`)
const updateDisabled = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '更新并重新连接').disabled`
const calls = (kind, count) => `document.querySelector('[data-testid="${kind}-calls"]').textContent === '${count}'`
const automaticUpdate = count => `document.querySelector('[role="dialog"][aria-busy="true"]')?.textContent.includes('正在通过 SSH 上传并校验服务包') && ${calls('update', count)}`
const dialogClosed = `![...document.querySelectorAll('[role="dialog"]')].some(d => d.querySelector('h2')?.textContent.includes('SSH') && d.querySelector('select'))`
const updateLayoutFits = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-busy="true"]');
  const rect = dialog.getBoundingClientRect();
  const footer = dialog.querySelector('footer').getBoundingClientRect();
  const progress = dialog.querySelector('[role="status"]').getBoundingClientRect();
  return rect.height <= innerHeight * .85 + 1 && rect.top >= 0 && rect.bottom <= innerHeight
    && footer.bottom <= rect.bottom && progress.bottom <= footer.top && progress.top > rect.top
    && rect.left >= 0 && rect.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth
    && document.documentElement.scrollWidth <= innerWidth;
})()`
try {
  run('set', 'viewport', '1200', '1000')
  run('open', 'http://127.0.0.1:38439/web-tests/server-version-update.html')
  click('远端服务版本不匹配 阶段：正在探测 原因：daemon 版本不匹配：远端 0.1.14-beta.9，本端 0.1.14-beta.12 点击查看详情')
  click('通过 SSH 更新远端服务')
  check('a verified local package automatically starts the update without download', `${automaticUpdate(1)} && ${calls('prepare', 1)} && ${calls('download', 0)}`)
  check('completion notification is withheld until the service is ready', `document.querySelector('[data-testid="notifications"]').textContent === ''`)
  capture('automatic-updating')
  fixtureClick('完成更新')
  check('automatic success closes the dialog and emits a completion notification', `${dialogClosed} && document.querySelector('[data-testid="notifications"]').textContent.includes('已更新远端服务')`)
  check('completion toast is visible above the remaining connection dialog', `(() => { const toast = document.querySelector('.toast-item'); if (!toast) return false; const r = toast.getBoundingClientRect(); return toast.textContent.includes('已更新远端服务') && toast.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) })()`)
  capture('automatic-complete')
  click('关闭通知')
  setScenario('missing')
  fixtureClick('打开更新弹窗')
  check('missing local package keeps manual recovery available without updating', `${updateDisabled} && ${calls('prepare', 2)} && ${calls('update', 1)} && ${calls('download', 0)} && !document.querySelector('[role="dialog"][aria-busy="true"]')`)
  check('desktop dialog stays compact and keeps the impact warning visible', `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1); return d.getBoundingClientRect().height < 600 && !d.querySelector('details').open && d.querySelector('[id$="-impact"]').getBoundingClientRect().height > 0 })()`)
  evaluate(`[...document.querySelectorAll('[role="dialog"]')].at(-1).querySelector('summary').click()`)
  check('supplementary update details can be expanded', `[...document.querySelectorAll('[role="dialog"]')].at(-1).querySelector('details[open]')?.textContent.includes('HTTPS / WSS')`)
  evaluate(`[...document.querySelectorAll('[role="dialog"]')].at(-1).querySelector('summary').click()`)
  check('expanding details never repeats automatic preparation', calls('prepare', 2))
  capture('automatic')
  click('取消')
  fixtureClick('打开更新弹窗')
  check('reopening prepares exactly once again', `${updateDisabled} && ${calls('prepare', 3)} && ${calls('update', 1)} && !document.querySelector('[role="dialog"][aria-busy="true"]')`)
  setSource('offline')
  check('offline mode explains the network boundary and requires a directory', `document.body.textContent.includes('本次更新不联网下载') && [...document.querySelectorAll('button')].find(b => b.textContent === '检查并准备服务包').disabled`)
  setScenario('cancel')
  click('选择离线目录')
  check('cancelling the picker leaves update disabled', updateDisabled)
  setScenario('old')
  click('选择离线目录')
  click('检查并准备服务包')
  check('old offline package shows both versions and prevents update', `${updateDisabled} && document.querySelector('[role="alert"]').textContent.includes('版本不匹配') && document.body.textContent.includes('0.1.14-beta.14')`)
  capture('offline-version-error')
  setScenario('missing')
  click('检查并准备服务包')
  check('missing target platform also prevents update', `${updateDisabled} && document.querySelector('[role="alert"]').textContent.includes('缺少')`)
  setScenario('cancel')
  click('选择离线目录')
  check('cancelling a reselect preserves diagnostics and never updates', `${updateDisabled} && document.querySelector('[role="alert"]').textContent.includes('缺少') && ${calls('update', 1)}`)
  setScenario('cached')
  click('检查并准备服务包')
  check('a verified selected offline package automatically updates from its directory', `${automaticUpdate(2)} && document.body.textContent.includes('/fixture/offline/servers/qingcode-server-windows-x86_64.exe')`)
  capture('offline-updating')
  fixtureClick('完成更新')
  check('selected offline update completes and closes the dialog', `${dialogClosed} && ${calls('update', 2)}`)
  click('关闭通知')
  setScenario('download')
  fixtureClick('打开更新弹窗')
  check('automatic checking does not download when no local package exists', `${updateDisabled} && ${calls('download', 0)} && ${calls('update', 2)} && document.querySelector('[role="alert"]').textContent.includes('本机离线包')`)
  click('检查并准备服务包')
  check('download progress identifies the local computer and locks controls', `document.querySelector('[role="dialog"][aria-busy="true"]').textContent.includes('正在本机下载并校验服务包') && [...document.querySelectorAll('button')].find(b => b.textContent === '取消').disabled`)
  capture('local-download')
  fixtureClick('完成准备')
  check('downloaded package waits for update confirmation and shows its cache path', `!(${updateDisabled}) && document.body.textContent.includes('/fixture/cache/servers/') && ${calls('update', 2)} && ${calls('download', 1)}`)
  fixtureClick('切换更新失败')
  click('更新并重新连接')
  check('update reports upload separately and blocks dismissal', `document.querySelector('[role="dialog"][aria-busy="true"]').textContent.includes('正在通过 SSH 上传并校验服务包') && [...document.querySelectorAll('button')].find(b => b.textContent === '取消').disabled`)
  capture('updating')
  run('set', 'viewport', '1366', '600')
  check('progress and footer remain visible in a short window', updateLayoutFits)
  evaluate(`document.documentElement.style.setProperty('--ui-font-size', '20px'); document.documentElement.style.setProperty('--ui-font-size-sm', '19px')`)
  check('large text keeps progress and actions visible', updateLayoutFits)
  capture('updating-large-text-short')
  evaluate(`document.documentElement.style.removeProperty('--ui-font-size'); document.documentElement.style.removeProperty('--ui-font-size-sm')`)
  run('set', 'viewport', '1200', '1000')
  fixtureClick('完成更新')
  check('failed update remains actionable and requires preparation again', `${updateDisabled} && document.querySelector('[role="alert"]').textContent.includes('update refused')`)
  setScenario('cached')
  fixtureClick('切换更新失败')
  click('检查并准备服务包')
  check('manual revalidation retries automatically when a local package is now available', automaticUpdate(4))
  fixtureClick('切换语言主题')
  run('set', 'viewport', '480', '900')
  check('English light dialog and footer fit a narrow viewport', `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1); const r = d.getBoundingClientRect(); const f = d.querySelector('footer').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && f.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth && d.textContent.includes('Automatic (default)') })()`)
  capture('light-english-narrow')
  run('set', 'viewport', '480', '600')
  check('English narrow short window keeps progress and footer visible', updateLayoutFits)
  capture('updating-light-narrow-short')
  fixtureClick('完成更新')
  check('success closes only the update dialog and emits one completion notification per successful attempt', `!document.body.textContent.includes('Automatic (default)') && ${calls('update', 4)} && document.querySelector('[data-testid="notifications"]').textContent.split(String.fromCharCode(10)).length === 3`)
  console.log(`Passed ${results.length} browser checks. Artifacts: ${artifactDir}`)
} catch (error) {
  results.push({ name: String(error), passed: false })
  capture('failure')
  writeFileSync(resolve(artifactDir, 'failure.txt'), run('snapshot', '-i'))
  process.exitCode = 1
} finally {
  writeFileSync(resolve(artifactDir, 'results.json'), JSON.stringify({ nativeIntegration: false, engine: 'agent-browser', results }, null, 2))
  writeFileSync(resolve(artifactDir, 'browser-errors.json'), run('errors', '--json'))
  run('close')
}
