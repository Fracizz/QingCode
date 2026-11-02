import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Run against pnpm test:web. Only the fixture's in-memory IPC adapter is used.
const session = process.env.AGENT_BROWSER_SESSION || `remote-overview-${process.pid}`
const artifactDir = resolve('.dev/web-tests/remote-connections')
mkdirSync(artifactDir, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
function check(name, condition) {
  run('wait', '--fn', condition)
  run('eval', `if (!(${condition})) throw new Error(${JSON.stringify(name)}); true`)
  results.push({ name, passed: true })
}
function capture(name) {
  run('screenshot', resolve(artifactDir, `${name}.png`))
}

try {
  run('set', 'viewport', '1440', '1000')
  run('open', 'http://127.0.0.1:38439/web-tests/remote-connections.html')
  run('wait', 'button[aria-current="true"]')
  check('overview opens without an SSH edit form', `!document.querySelector('[aria-label="主机"]') && [...document.querySelectorAll('button')].some(b => b.textContent === '编辑连接')`)
  check('recent projects are capped at five', `[...document.querySelectorAll('button')].filter(b => b.textContent === '打开').length === 5`)
  capture('overview-dark')
  run('fill', '[aria-label="搜索连接或项目"]', '/HOME/CODE/SERVICE-0')
  check('hidden project paths match case-insensitively', `document.querySelector('aside').textContent.includes('WSL') && !document.querySelector('aside').textContent.includes('WinDev')`)
  run('focus', '[aria-label="搜索连接或项目"]')
  run('press', 'Control+a')
  run('press', 'Backspace')
  click('需要处理 · 1')
  check('attention filter includes failed checks', `document.querySelector('aside').textContent.includes('WinDev') && !document.querySelector('aside').textContent.includes('Build Server')`)
  click('WinDev administrator@192.0.2.107:28822 检查失败 · 3 个项目')
  check('failed checks expose their reason', `document.querySelector('section').textContent.includes('Fixture: authentication required')`)
  capture('overview-error')
  click('需要处理 · 1')
  click('WSL root@localhost 服务已就绪 · 9 个项目')
  click('查看全部项目')
  check('all projects can be expanded', `[...document.querySelectorAll('button')].filter(b => b.textContent === '打开').length === 9`)
  click('收起项目')
  click('编辑连接')
  check('editing retains the connection test and save actions', `document.querySelector('input[value="localhost"]') && [...document.querySelectorAll('footer button')].some(b => b.textContent === '测试连接')`)
  capture('connection-edit')
  click('返回概览')
  check('returning restores the overview', `!document.querySelector('input[value="localhost"]')`)
  click('查看远端服务日志')
  check('logs load only when requested', `document.querySelectorAll('[role="dialog"]').length === 2 && document.body.textContent.includes('[fixture] remote service ready')`)
  run('press', 'Escape')
  click('关闭')
  click('切换主题')
  click('切换语言')
  click('打开远程连接')
  run('set', 'viewport', '800', '900')
  run('eval', `document.documentElement.style.setProperty('--ui-font-size','20px')`)
  check('narrow English light overview does not overflow', `document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[role="dialog"], section, aside')].every(e => e.scrollWidth <= e.clientWidth + 1)`)
  capture('overview-light-en-narrow')
  click('Edit connection')
  check('narrow edit form keeps its footer within the dialog', `document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight && document.querySelector('section').scrollWidth <= document.querySelector('section').clientWidth + 1`)
  capture('edit-light-en-narrow')
  click('Back to overview')
  run('find', 'role', 'button', 'click', '--name', 'Build Server')
  check('Server endpoint is displayed without SSH placeholders', `document.querySelector('section').textContent.includes('build.example.test:48763') && !document.querySelector('section').textContent.includes('Agent@')`)
  capture('server-direct')
  console.log(`Passed ${results.length} browser checks. Artifacts: ${artifactDir}`)
} catch (error) {
  capture('failure')
  writeFileSync(resolve(artifactDir, 'failure-snapshot.txt'), run('snapshot', '-i'))
  results.push({ name: String(error), passed: false })
  process.exitCode = 1
} finally {
  writeFileSync(resolve(artifactDir, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  writeFileSync(resolve(artifactDir, 'report.html'), `<!doctype html><meta charset="UTF-8"><title>Remote connection overview acceptance</title><h1>Browser fixture acceptance</h1><p>Engine: agent-browser. Native SSH/PTY and persistence were not exercised.</p><pre>${JSON.stringify(results, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`)
  writeFileSync(resolve(artifactDir, 'browser-errors.json'), run('errors', '--json'))
  run('close')
}
