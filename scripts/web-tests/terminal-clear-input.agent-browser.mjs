import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// pnpm dev:web-test (38419): production terminal and stores, memory-only PTY transport.
const session = `terminal-clear-input-${process.pid}`
const output = resolve('.dev/web-tests/terminal-clear-input')
mkdirSync(output, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], {
  encoding: 'utf8', timeout: 30000,
})
const evaluate = expression => run('eval', expression)
const check = (name, expression) => {
  run('wait', '--fn', `Boolean(${expression})`)
  results.push({ name, passed: true })
}
const click = name => run('find', 'role', 'menuitem', 'click', '--name', name, '--exact')
const openMenu = () => {
  evaluate(`document.querySelector('.xterm-screen').dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 150, clientY: 160, shiftKey: true,
  }))`)
  run('wait', '[role="menu"]')
}
const configure = patch => evaluate(`(async () => {
  const { useTerminalStore } = await import('/src/store/terminalStore.ts')
  useTerminalStore.setState(s => ({ terminals: s.terminals.map(tab => ({ ...tab, ...${JSON.stringify(patch)} })) }))
  window.terminalFixture.state.input.length = 0
  return true
})()`)
const send = data => evaluate(`window.terminalFixture.output(${JSON.stringify(data)})`)
const input = 'window.terminalFixture.state.input'
const hasClear = `[...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === '清除终端输入')`

try {
  run('set', 'viewport', '1100', '760')
  run('open', 'http://127.0.0.1:38419/web-tests/terminal-interaction.html')
  run('wait', '.xterm-screen')
  evaluate(`(async () => {
    const { terminalReader } = await import('/src/lib/terminal/terminalContent.ts')
    const { useTerminalDraftStore } = await import('/src/store/terminalDraftStore.ts')
    const { useTerminalStore } = await import('/src/store/terminalStore.ts')
    // Keep the waiting-for-PTY scenario pending without invoking native process creation.
    useTerminalStore.setState({ spawnPendingTerminal: async () => {} })
    window.readBuffer = () => terminalReader('terminal-interaction-fixture')('buffer')
    useTerminalDraftStore.getState().setDraft('terminal-interaction-fixture', 'keep composer draft')
    return true
  })()`)
  send('\x1bcprevious output\r\n$ pending input')
  evaluate('(async () => { window.beforeClear = await window.readBuffer(); return true })()')
  configure({ shell: 'bash' })
  openMenu()
  run('screenshot', resolve(output, 'dark-menu.png'))
  click('清除终端输入')
  check('POSIX input uses editing keys and returns focus', `${input}.length === 1 && ${input}[0] === '\x05\x15' && document.activeElement?.getAttribute('aria-label') === 'Terminal input'`)
  assert.match(evaluate('(async () => (await window.readBuffer()) === window.beforeClear)()'), /true/)
  assert.match(evaluate(`(async () => {
    const { useTerminalDraftStore } = await import('/src/store/terminalDraftStore.ts')
    return useTerminalDraftStore.getState().drafts['terminal-interaction-fixture'] === 'keep composer draft'
  })()`), /true/)
  results.push({ name: 'clearing input preserves terminal output and composer draft', passed: true })

  for (const [name, shell, resolvedShell, bracketed, expected] of [
    ['PowerShell prompt', 'powershell', null, false, '\x1b'],
    ['CMD prompt', 'cmd', null, false, '\x1b'],
    ['resolved shell overrides profile', 'bash', 'pwsh', false, '\x1b'],
    ['AI input inside Windows shell', 'pwsh', null, true, '\x05\x15'],
  ]) {
    send(bracketed ? '\x1b[?2004h' : '\x1b[?2004l')
    configure({ shell, resolvedShell })
    openMenu()
    click('清除终端输入')
    check(name, `${input}.length === 1 && ${input}[0] === ${JSON.stringify(expected)}`)
  }

  // A captured menu action must recheck permissions when clicked.
  for (const status of ['starting', 'reconnecting', 'exited']) {
    configure({ status: 'running' })
    openMenu()
    configure({ status })
    click('清除终端输入')
    check(`stale action does not write after ${status}`, `${input}.length === 0`)
    openMenu()
    check(`action is hidden while ${status}`, `!(${hasClear})`)
    run('press', 'Escape')
  }
  configure({ status: 'running', ptySpawnPending: false })
  openMenu()
  configure({ ptySpawnPending: true })
  click('清除终端输入')
  check('stale action does not write before the PTY starts', `${input}.length === 0`)
  openMenu()
  check('action is hidden before the PTY starts', `!(${hasClear})`)
  run('press', 'Escape')
  configure({ ptySpawnPending: false })
  configure({ status: 'running' })
  openMenu()
  evaluate(`(async () => {
    const { useTerminalControlStore } = await import('/src/store/terminalControlStore.ts')
    useTerminalControlStore.getState().setControl('terminal-interaction-fixture', { name: 'phone', cols: 80, rows: 24 })
    return true
  })()`)
  click('清除终端输入')
  check('stale action does not write after another device takes control', `${input}.length === 0`)
  openMenu()
  check('action is hidden for a controlled terminal', `!(${hasClear})`)
  run('press', 'Escape')
  evaluate(`(async () => {
    const { useTerminalControlStore } = await import('/src/store/terminalControlStore.ts')
    const { ensureBuiltinLocaleLoaded, useLocaleStore } = await import('/src/lib/i18n.ts')
    useTerminalControlStore.getState().clearControl('terminal-interaction-fixture')
    await ensureBuiltinLocaleLoaded('en')
    useLocaleStore.getState().setLanguage('en')
    document.documentElement.dataset.theme = 'light'
    return true
  })()`)
  run('set', 'viewport', '480', '650')
  openMenu()
  check('English label and narrow light menu fit the viewport', `[...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === 'Clear terminal input') && document.querySelector('[role="menu"]').getBoundingClientRect().right <= innerWidth`)
  run('screenshot', resolve(output, 'light-narrow-menu.png'))
} finally {
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  run('close')
}
console.log(JSON.stringify({ output, checks: results.length }))
