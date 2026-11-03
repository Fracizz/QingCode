import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `scm-branches-${process.pid}`
const directory = resolve('.dev/web-tests/scm-branches')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const check = (name, condition) => {
  run('wait', '--fn', condition)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(directory, `${name}.png`))
// The virtual list exposes its scroll container; the small list uses overflow-auto.
const scroller = '[role="menu"] [role="list"], [role="menu"] .overflow-auto'
try {
  run('set', 'viewport', '1200', '800')
  run('open', 'http://127.0.0.1:38439/web-tests/scm-branches.html')
  check('large branch list renders with a ten-branch viewport', `(() => {
    const menu = document.querySelector('[role="menu"]');
    const list = menu?.querySelector('[role="list"]');
    if (!list || list.clientHeight !== 416 || list.scrollHeight <= list.clientHeight) return false;
    const box = list.getBoundingClientRect();
    return [...menu.querySelectorAll('[data-branch-name]')].filter(el => {
      const row = el.parentElement.getBoundingClientRect();
      return row.top >= box.top && row.bottom <= box.bottom;
    }).length === 10;
  })()`)
  capture('ten-branches-dark')
  run('scroll', 'down', '10000', '--selector', scroller)
  check('scroll reaches the last remote branch while search stays fixed', `(() => {
    const list = document.querySelector('[role="menu"] [role="list"]');
    const input = document.querySelector('input[type="search"]');
    return list.scrollTop > 0 && !!document.querySelector('[data-branch-name="origin/remote-19"]') && input.getBoundingClientRect().top < list.getBoundingClientRect().top;
  })()`)
  capture('scrolled-remote')
  run('fill', 'input[type="search"]', 'topic-29')
  check('search covers branches beyond the first ten and shrinks the menu', `document.querySelectorAll('[data-branch-name]').length === 1 && !!document.querySelector('[data-branch-name="topic-29"]') && document.querySelector('[role="menu"]').offsetHeight < 200`)
  run('press', 'Enter')
  check('Enter selects the filtered branch', `document.querySelector('[data-testid="switched"]').textContent === 'topic-29'`)
  run('fill', 'input[type="search"]', 'missing-branch')
  check('unmatched filter displays an empty state', `!document.querySelector('[data-branch-name]') && document.querySelector('[role="menu"]').textContent.includes('没有匹配的分支')`)
  run('press', 'Control+a')
  run('press', 'Backspace')
  check('clearing search restores the first branches', `!!document.querySelector('[data-branch-name="topic-00"]')`)
  run('press', 'ArrowUp')
  check('keyboard wraps to an unmounted remote row and scrolls it into view', `(() => {
    const row = document.querySelector('[data-branch-name="origin/remote-19"]')?.getBoundingClientRect();
    const box = document.querySelector('[role="menu"] [role="list"]')?.getBoundingClientRect();
    return row && box && row.top >= box.top && row.bottom <= box.bottom + 1;
  })()`)
  run('press', 'Enter')
  check('Enter switches to the remote branch after keyboard scrolling', `document.querySelector('[data-testid="switched"]').textContent === 'origin/remote-19'`)
  click('少量分支')
  check('small list displays its current branch and sizes to content', `document.querySelectorAll('[data-branch-name]').length === 2 && document.querySelector('[data-branch-name="topic-00"]').disabled && document.querySelector('[role="menu"]').offsetHeight < 200`)
  click('空仓库')
  check('empty repository keeps its status visible', `document.querySelector('[role="menu"]').textContent.includes('暂无本地分支') && document.querySelector('[role="menu"]').offsetHeight > 70`)
  click('加载中')
  check('loading status stays visible', `document.querySelector('[role="menu"]').textContent.includes('正在读取分支')`)
  click('大量分支')
  run('set', 'viewport', '420', '360')
  check('short narrow window constrains the list and preserves scrolling', `(() => {
    const menu = document.querySelector('[role="menu"]').getBoundingClientRect();
    const list = document.querySelector('[role="menu"] [role="list"]');
    return menu.right <= innerWidth && menu.bottom <= innerHeight && list.clientHeight > 80 && list.scrollHeight > list.clientHeight && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  capture('short-narrow')
  run('set', 'viewport', '800', '600')
  run('eval', `document.documentElement.dataset.theme = 'light'; document.documentElement.style.setProperty('--ui-font-size', '20px'); window.dispatchEvent(new Event('qingcode:font-settings-changed'))`)
  check('large font updates virtual row measurements and stays within the window', `(() => {
    const list = document.querySelector('[role="menu"] [role="list"]');
    return document.querySelector('[role="menu"]').getBoundingClientRect().bottom <= innerHeight && document.documentElement.dataset.theme === 'light' && list.clientHeight > 350 && list.scrollHeight > 2500;
  })()`)
  capture('light-large-font')
  const errors = JSON.parse(run('errors', '--json')).data.errors
  if (errors.length) throw new Error(`Unexpected browser errors: ${JSON.stringify(errors)}`)
  results.push({ name: 'no uncaught browser errors', passed: true })
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
