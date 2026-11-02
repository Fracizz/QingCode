import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `server-startup-${process.pid}`
const artifactDir = resolve('.dev/web-tests/server-startup')
mkdirSync(artifactDir, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const check = (name, condition) => {
  run('wait', '--fn', condition)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(artifactDir, `${name}.png`))
try {
  run('set', 'viewport', '1050', '1050')
  run('open', 'http://127.0.0.1:38439/web-tests/direct-agent.html')
  click('打开启动与自启')
  check('startup defaults on without any automatic SSH action', `document.querySelector('[data-testid="recovery"] [role="switch"]').checked && document.querySelector('output').textContent === '[]'`)
  capture('default-on')
  run('find', 'role', 'switch', 'click', '--name', '开机自启 Server')
  click('应用自启设置')
  check('turning startup off applies registration without reconnecting', `document.querySelector('output').textContent.includes('manage:false:false') && !document.querySelector('output').textContent.includes('reconnect')`)
  click('通过 SSH 启动 Server')
  check('explicit SSH startup reconnects after success', `document.querySelector('output').textContent.includes('manage:true:false') && document.querySelector('output').textContent.includes('reconnect')`)
  run('select', 'select', 'startup')
  click('通过 SSH 启动 Server')
  check('startup permission failures provide an actionable message', `document.querySelector('[data-testid="recovery"] [role="alert"]').textContent.includes('管理员权限')`)
  capture('permission-error')
  run('find', 'role', 'checkbox', 'click', '--name', '包含 SSH 配置')
  check('missing SSH presents a setup action', `[...document.querySelectorAll('[data-testid="recovery"] button')].some(b => b.textContent === '配置 SSH 连接') && ![...document.querySelectorAll('[data-testid="recovery"] button')].some(b => b.textContent === '通过 SSH 启动 Server')`)
  run('find', 'text', '远端手动启动命令', 'click', '--exact')
  check('manual commands preserve the paired port and disabled startup choice', `document.querySelector('[data-testid="recovery"] code').textContent.includes('direct --port 48763 --detach') && document.querySelector('[data-testid="recovery"] code').textContent.includes('startup disable')`)
  capture('manual-start')
  run('find', 'role', 'checkbox', 'click', '--name', '包含 SSH 配置')
  click('切换主题')
  click('切换语言')
  run('set', 'viewport', '480', '900')
  check('English light layout fits a narrow viewport', `document.documentElement.scrollWidth <= innerWidth && document.querySelector('[data-testid="recovery"]').textContent.includes('Start Server via SSH')`)
  capture('light-en-narrow')
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
