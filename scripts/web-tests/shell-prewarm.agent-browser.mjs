import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `shell-prewarm-${process.pid}`
const output = resolve('.dev/web-tests/shell-prewarm')
mkdirSync(output, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = (name, role = 'button') => run('find', 'role', role, 'click', '--name', name, '--exact')
const check = (name, condition) => {
  run('wait', '--fn', `Boolean(${condition})`)
  results.push({ name, passed: true })
}
const label = '终端 › 集成: Shell 预热数量'
const control = `document.querySelector('button[aria-label="${label}"]')`
const saved = `JSON.parse(JSON.stringify([...window.shellPrewarmFixture.disk.values()])).some(text => text.includes('"terminal.integrated.shellPrewarmCount": 8'))`
try {
  run('set', 'viewport', '1100', '720')
  run('open', 'http://127.0.0.1:38439/web-tests/shell-prewarm.html')
  check('Windows defaults to automatic mode', `${control}?.textContent.includes('自动')`)
  click(label)
  check('offers auto, off, and exactly eight manual counts', `document.querySelectorAll('[role="option"]').length === 10`)
  click('8', 'option')
  check('manual eight is saved to the user JSON5 file', `${control}?.textContent === '8' && ${saved}`)
  click('重新打开设置')
  check('manual count survives reopening settings', `${control}?.textContent === '8'`)
  click('用户作用域')
  check('workspace scope cannot override the user count', `${control}?.disabled && ${control}?.textContent === '8'`)
  run('screenshot', resolve(output, 'workspace-locked.png'))
  click('工作区作用域')
  click(label)
  click('关闭', 'option')
  check('can disable prewarming', `${control}?.textContent === '关闭'`)
  click(label)
  click('自动（按物理内存）', 'option')
  check('can return to automatic mode', `${control}?.textContent.includes('自动')`)
  click('Windows')
  check('setting is hidden on Linux', `!${control}`)
  click('Linux')
  run('eval', `(async () => {
    const { ensureBuiltinLocaleLoaded, useLocaleStore } = await import('/src/lib/i18n.ts')
    await ensureBuiltinLocaleLoaded('en'); useLocaleStore.setState({ language: 'en' })
    document.documentElement.dataset.theme = 'light'; return true
  })()`)
  run('set', 'viewport', '420', '760')
  check('English light setting fits narrow windows', `document.querySelector('button[aria-label="Terminal › Integrated: Prewarmed Shells"]') && document.documentElement.scrollWidth <= innerWidth`)
  run('screenshot', resolve(output, 'light-en-narrow.png'))
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { writeFileSync(resolve(output, 'failure-snapshot.txt'), run('snapshot', '-i')) } catch { /* best effort */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  try { writeFileSync(resolve(output, 'browser-errors.json'), run('errors', '--json')) } catch { /* best effort */ }
  try { run('close') } catch { /* isolated session */ }
  console.log(`${results.filter(result => result.passed).length}/${results.length} checks passed. ${output}`)
}
