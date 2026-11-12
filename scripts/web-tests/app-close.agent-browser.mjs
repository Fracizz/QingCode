import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `qingcode-app-close-${Date.now()}`
const output = resolve('.dev/web-tests/app-close')
mkdirSync(output, { recursive: true })
const results = []
function browser(...args) {
  return execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8' }).trim()
}
function click(name) { browser('find', 'text', name, 'click', '--exact') }
function verify(name, expression) {
  browser('eval', `(() => { if (!(${expression})) throw new Error(${JSON.stringify(name)}); return true })()`)
  results.push({ name, passed: true })
}
const events = "document.querySelector('[data-testid=exit-events]').textContent"
const dialog = "document.querySelector('[role=alertdialog]')"
try {
  browser('open', 'http://127.0.0.1:38439/web-tests/app-close.html')
  browser('set', 'viewport', '1440', '900')
  click('混合终端退出')
  verify('separates persistent, compatibility, local and transfer effects',
    `${dialog}.textContent.includes('2 个远程终端') && ${dialog}.textContent.includes('24 小时') && ${dialog}.textContent.includes('1 个本地终端') && ${dialog}.textContent.includes('2 项文件传输')`)
  verify('preserve is initially focused', "document.activeElement.textContent === '保留远程终端并退出'")
  browser('screenshot', resolve(output, 'dark.png'))
  click('保留远程终端并退出')
  verify('preserve only detaches remote sessions and flushes before destroy',
    `${events}.includes('preserve:SSH') && ${events}.includes('preserve:Server') && !${events}.includes('terminate:') && ${events}.indexOf('flush') < ${events}.indexOf('destroy')`)

  click('混合终端退出')
  click('结束远程终端并退出')
  browser('wait', '--fn', "document.querySelector('[role=status]')?.textContent === '正在结束终端（3/4）…'")
  browser('press', 'Escape')
  verify('pending cleanup keeps the progress dialog visible', "!!document.querySelector('[role=dialog] [role=status]')")
  browser('screenshot', resolve(output, 'terminating.png'))
  browser('wait', '--fn', `${events}.includes('destroy')`)
  verify('terminate records both remote sessions ended', `${events}.includes('ended:SSH') && ${events}.includes('ended:Server') && !${events}.includes('preserve:')`)

  click('模拟远端未确认')
  click('结束远程终端并退出')
  verify('unconfirmed termination offers retry and keeps window open', `${dialog}.textContent.includes('部分终端未确认结束') && !${events}.includes('destroy')`)
  browser('screenshot', resolve(output, 'unconfirmed.png'))
  click('重试')
  verify('retry only retries the failed terminal', `${events}.includes('terminate:SSH') && ${events}.split('terminate:Server').length === 2 && ${events}.includes('destroy')`)

  click('模拟远端未确认')
  click('结束远程终端并退出')
  click('仍然退出')
  verify('quit anyway keeps uncertain PTY recoverable', `${events}.includes('preserve:SSH') && !${events}.includes('ended:SSH') && ${events}.includes('destroy')`)

  browser('check', 'input[type=checkbox]')
  click('混合终端退出')
  click('结束远程终端并退出')
  verify('cancelled file confirmation has no terminal side effects', `${events} === ${JSON.stringify('pause\nfiles\nresume')}`)
  browser('uncheck', 'input[type=checkbox]')
  click('混合终端退出')
  browser('press', 'Escape')
  verify('Escape cancels without side effects', `${events} === ${JSON.stringify('pause\nresume')} && !${dialog}`)

  click('仅本地终端退出')
  verify('local-only window has no preserve choice', `!${dialog}.textContent.includes('保留远程终端')`)
  click('退出')
  verify('local-only exit closes local shell', `${events}.includes('close:local') && ${events}.includes('destroy')`)

  browser('set', 'viewport', '480', '800')
  click('切换主题')
  click('切换语言')
  browser('wait', '--fn', "document.documentElement.lang === 'en'")
  click('混合终端退出')
  browser('screenshot', resolve(output, 'light-en-narrow.png'))
  verify('English narrow light dialog remains inside viewport', `${dialog}.textContent.includes('Keep Remote Terminals and Quit') && ${dialog}.getBoundingClientRect().left >= 0 && ${dialog}.getBoundingClientRect().right <= innerWidth && ${dialog}.getBoundingClientRect().bottom <= innerHeight`)
  browser('press', 'Escape')
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ results, passed: results.length }, null, 2))
  console.log(`Passed ${results.length} browser checks; screenshots and results: ${output}`)
} finally {
  browser('close')
}
