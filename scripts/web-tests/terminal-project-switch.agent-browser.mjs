import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// pnpm dev:web-test (38419): real App/stores with isolated in-memory native operations.
const session = `terminal-project-switch-${process.pid}`
const output = resolve('.dev/web-tests/terminal-project-switch')
mkdirSync(output, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], {
  encoding: 'utf8', timeout: 30000,
})
const click = (name, role = 'button') => run('find', 'role', role, 'click', '--name', name, '--exact')
const check = (name, condition) => {
  run('wait', '--fn', `Boolean(${condition})`)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(output, `${name}.png`))
const currentIs = name => `document.querySelector('[data-terminal-project-group][aria-current="true"]')?.getAttribute('aria-label') === '${name}'`
const menu = name => click(`「${name}」的项目操作`)
try {
  run('set', 'viewport', '1280', '850')
  run('open', `http://127.0.0.1:38419/?testSession=${session}`)
  run('wait', '--fn', 'Boolean(window.__QINGCODE_TEST__ && document.querySelector("button[aria-label=设置]"))')
  click('打开项目')
  click('信任并继续')
  click('选择面板布局')
  click('终端工作台（左侧列表）', 'menuitemcheckbox')
  run('eval', `(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts')
    void useProjectStore.getState().addProject('/workspace/other')
    return true
  })()`)
  click('信任并继续')
  check('both projects are listed without terminal sessions', `document.querySelectorAll('[data-terminal-project-group]').length === 2 && window.__QINGCODE_TEST__.terminalIds().length === 0`)
  menu('demo')
  check('switch project is the first menu action', `document.querySelector('[role="menuitem"]')?.textContent === '切换到此项目'`)
  capture('switch-menu')
  click('切换到此项目', 'menuitem')
  check('empty project becomes current without creating a terminal or changing the layout', `${currentIs('demo')} && document.querySelector('.workspace-grid').dataset.panelLayout === 'terminalWorkbench' && document.querySelector('button[aria-label="终端列表"]').getAttribute('aria-pressed') === 'true' && window.__QINGCODE_TEST__.terminalIds().length === 0`)
  check('terminal empty state belongs to the selected project', `document.querySelector('[data-terminal-panel]').textContent.includes('当前项目「demo」暂无终端')`)
  menu('demo')
  check('current project is marked and disabled', `document.querySelector('[role="menuitem"]')?.textContent === '当前项目' && document.querySelector('[role="menuitem"]').disabled`)
  run('press', 'Escape')
  run('eval', `window.__QINGCODE_TEST__.setLatency('validate_directory', 1500); window.__QINGCODE_TEST__.failNext('validate_directory', 'project switch acceptance failure'); true`)
  menu('other')
  click('切换到此项目', 'menuitem')
  check('project header shows progress', `document.querySelector('[data-terminal-project-header][aria-busy="true"] [aria-label="正在切换项目…"]')`)
  menu('other')
  check('pending switch cannot be duplicated', `document.querySelector('[role="menuitem"]').disabled`)
  run('press', 'Escape')
  check('failed switch retains the original project and clears progress', `${currentIs('demo')} && !document.querySelector('[data-terminal-project-header][aria-busy="true"]') && document.body.textContent.includes('project switch acceptance failure')`)
  run('eval', `window.__QINGCODE_TEST__.setLatency('validate_directory', 0); true`)
  menu('other')
  click('切换到此项目', 'menuitem')
  check('retry switches to the empty target project', `${currentIs('other')} && window.__QINGCODE_TEST__.terminalIds().length === 0`)
  capture('empty-project')
  run('eval', `(async () => {
    const { ensureBuiltinLocaleLoaded, useLocaleStore } = await import('/src/lib/i18n.ts')
    await ensureBuiltinLocaleLoaded('en')
    useLocaleStore.setState({ language: 'en' })
    document.documentElement.dataset.theme = 'light'
    return true
  })()`)
  run('set', 'viewport', '800', '700')
  click('Actions for "demo"')
  check('English light menu fits a narrow viewport', `document.querySelector('[role="menuitem"]')?.textContent === 'Switch to This Project' && document.querySelector('[role="menu"]').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth`)
  capture('light-en-menu')
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure'); writeFileSync(resolve(output, 'failure-snapshot.txt'), run('snapshot', '-i')) } catch { /* Browser may not have started. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  try { writeFileSync(resolve(output, 'browser-errors.json'), run('errors', '--json')) } catch { /* Browser may not have started. */ }
  try { run('close') } catch { /* Close only this script's browser session. */ }
  console.log(`${results.filter(result => result.passed).length}/${results.length} checks passed. ${output}`)
}
