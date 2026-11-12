import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `paste-cleanup-${process.pid}`
const directory = resolve('.dev/web-tests/terminal-paste-cleanup')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const retention = `document.querySelector('select[aria-label="终端 › 集成: 粘贴附件保留天数"]')`
const fixture = 'window.pasteCleanupFixture'

try {
  run('set', 'viewport', '1100', '760')
  run('open', 'http://127.0.0.1:38439/web-tests/terminal-paste-cleanup.html')
  check('off by default; only supported retention options', `${retention}?.value === '0' && [...${retention}.options].map(o => o.value).join() === '0,7,15,30'`)
  run('select', 'select[aria-label="终端 › 集成: 粘贴附件保留天数"]', '7')
  check('global setting persists without running cleanup', `${fixture}.disk.get('/fixture/default-settings.json')?.includes('"terminal.integrated.pasteRetentionDays": 7') && ${fixture}.cleanups.length === 0`)
  click('重新打开设置')
  check('setting survives reopening', `${retention}?.value === '7'`)
  click('用户作用域')
  check('workspace inherits global preference', `${retention}?.value === '7'`)
  run('select', 'select[aria-label="终端 › 集成: 粘贴附件保留天数"]', '0')
  check('workspace can explicitly disable cleanup', `${fixture}.disk.get('/fixture/app/.qingcode/project-settings.json')?.includes('"terminal.integrated.pasteRetentionDays": 0')`)
  click('清理粘贴文件')
  check('manual cleanup warns about historical paths', `document.querySelector('[role="alertdialog"]')?.textContent.includes('历史终端和会话中的附件路径会失效')`)
  click('取消')
  check('cancel does not delete anything', `${fixture}.cleanups.length === 0`)
  for (const [index, command] of [['0', 'cleanup_terminal_paste'], ['1', 'cleanup_terminal_paste'], ['2', 'ssh_cleanup_terminal_paste']]) {
    run('select', 'select[aria-label="项目类型"]', index)
    click('清理粘贴文件')
    click('清理')
    check(`manual cleanup uses correct transport for ${index}`, `${fixture}.cleanups.at(-1)?.command === '${command}' && ${fixture}.cleanups.at(-1)?.retentionDays === 0`)
  }
  run('screenshot', resolve(directory, 'dark.png'))
  click('English / light')
  run('set', 'viewport', '480', '760')
  check('English labels and narrow light layout', `document.querySelector('select[aria-label="Terminal › Integrated: Paste attachment retention"]') && !document.body.textContent.includes('终端 › 集成: 粘贴附件保留天数') && document.documentElement.scrollWidth <= innerWidth`)
  run('screenshot', resolve(directory, 'light-narrow.png'))
  run('errors')
} catch (error) {
  writeFileSync(resolve(directory, 'failure.json'), run('eval', `({text:document.body.textContent,value:document.querySelectorAll('select')[1]?.value,files:[...${fixture}.disk].map(([p,s])=>[p,s.match(/pasteRetentionDays[^\\n]*/g)])})`))
  throw error
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  run('close')
}
