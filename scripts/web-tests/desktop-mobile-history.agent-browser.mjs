import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `desktop-mobile-history-${process.pid}`
const directory = resolve('.dev/web-tests/desktop-mobile-history')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], {
  encoding: 'utf8', timeout: 30000,
})
const evaluate = expression => run('eval', expression)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const clickButton = text => run('find', 'role', 'button', 'click', '--name', text, '--exact')
const history = 'document.querySelector(\'[role="region"][aria-label="终端历史"]\')'
const wheelUp = `document.querySelector('.xterm-screen').dispatchEvent(
  new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaY:-120 }))`

try {
  run('set', 'viewport', '1100', '730')
  run('open', 'http://127.0.0.1:38419/web-tests/terminal-interaction.html?mobile-history')
  check('the first PTY resize uses the actual desktop pane', `window.terminalFixture?.sizes[0]?.cols > 42`)
  check('attach does not fetch history pages', 'window.terminalFixture.historyRequests.length === 0')
  evaluate(wheelUp)
  check('upward wheel opens history from the current screen', `${history}?.textContent.includes('历史输出 401')`)
  evaluate(`(() => {
    const history = ${history};
    history.scrollTop = 12;
    window.anchor = history.querySelector('pre').getBoundingClientRect().top;
  })()`)
  check('the first page is prepended without moving the reading position', `
    ${history}?.textContent.includes('历史输出 281')
    && Math.abs([...(${history}).querySelectorAll('pre')].find(pre => pre.textContent.startsWith('历史输出 401'))
      .getBoundingClientRect().top - window.anchor) <= 2
    && JSON.stringify(window.terminalFixture.historyRequests) === '[400]'`)
  for (const line of ['161', '041', '001']) {
    evaluate(`(${history}).scrollTop = 0`)
    check(`loads back to line ${line}`, `${history}?.textContent.includes('历史输出 ${line}')`)
  }
  check('every retained line is present exactly once and in order', `(() => {
    const lines = [...(${history}).textContent.matchAll(/历史输出 (\\d{3})/g)].map(match => Number(match[1]));
    return lines.length === 600 && lines.every((line, index) => line === index + 1);
  })()`)
  run('screenshot', resolve(directory, 'desktop-history.png'))
  evaluate(`window.terminalFixture.output('NEW LIVE OUTPUT\\r\\n')`)
  check('history stays open while the active terminal parses new output', `${history}?.textContent.includes('历史输出 001')`)
  evaluate(`(${history}).scrollTop = (${history}).scrollHeight`)
  check('scrolling back to the bottom returns to the live terminal', `!(${history})`)
  check('keyboard focus returns to the terminal', "document.activeElement?.classList.contains('xterm-helper-textarea')")
  run('set', 'viewport', '780', '590')
  check('the live terminal follows a narrower window', `window.terminalFixture.sizes.at(-1).cols < window.terminalFixture.sizes[0].cols`)
  evaluate(`window.terminalFixture.output('\\x1b[?1049h\\x1b[?1000h')`)
  evaluate(wheelUp)
  check('the alternate screen keeps its normal wheel behavior', `!(${history})`)
  evaluate(`document.querySelector('.xterm-screen').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles:true, cancelable:true, shiftKey:true, clientX:50, clientY:60, button:2
  }))`)
  run('find', 'text', '查看历史', 'click', '--exact')
  check('the terminal context menu opens history from the alternate screen', `!!(${history})`)
  clickButton('回到最新')

  run('open', 'http://127.0.0.1:38439/web-tests/terminal-manager.html?mobile-history')
  run('find', 'role', 'tab', 'click', '--name', '手机 1', '--exact')
  clickButton('只读预览：重新发布 0.03')
  clickButton('查看历史')
  clickButton('加载更早输出')
  check('the eye preview uses the same cursor and reaches the same preceding lines', `
    ${history}?.textContent.includes('历史输出 281') && window.__mobileTerminalHistoryRequests[0] === 400`)
  run('screenshot', resolve(directory, 'preview-history.png'))
  clickButton('回到最新')

  run('open', 'http://127.0.0.1:38439/web-tests/terminal-manager.html?mobile-reattach')
  run('find', 'role', 'tab', 'click', '--name', '手机 3', '--exact')
  clickButton('全部接回')
  check('bulk attach opens both live sessions and leaves the exited session alone', `
    JSON.stringify(window.__terminalManagerFixture.operations().filter(op => op.action === 'openMobileSessionTab')
      .flatMap(op => op.ids).sort()) === '["mobile-50","mobile-preview"]'
    && document.body.textContent.includes('已在电脑打开')`)
  run('screenshot', resolve(directory, 'bulk-reattach.png'))
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  run('close')
}
