import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-completion-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-completion')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(directory, `${name}.png`))
const inputs = `window.__mobileFixture.state.inputs.join('')`
const rawFocused = `document.activeElement === window.__completionTerm.textarea && document.querySelector('#keyboard').getAttribute('aria-pressed') === 'true'`
const resetInputs = () => evaluate('window.__mobileFixture.state.inputs.length = 0')

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('fixture loads the real Android web assets', `typeof window.qingLink === 'function'`)
  evaluate(`window.Terminal = class extends window.Terminal { constructor(...args) { super(...args); window.__completionTerm = this; } }; window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('computer is connected', `document.querySelector('#active-host').dataset.state === 'online'`)
  run('click', '#dashboard-nav [data-page="project"]')
  run('click', '#project-list > :first-child .project-row:first-child .row')
  evaluate('window.__mobileFixture.startTerminalIfEmpty()')
  check('terminal is ready', `document.querySelector('#terminal-status').textContent === '会话中' && !document.querySelector('#slash-command').disabled`)

  resetInputs()
  run('click', '#slash-command')
  check('skill entry sends only slash and opens the real-time keyboard', `${inputs} === '/' && ${rawFocused}`)
  run('keyboard', 'type', 'eff')
  check('typing the prefix reaches the terminal before Enter', `${inputs} === '/eff' && !${inputs}.includes(String.fromCharCode(13))`)
  run('click', '#special-keys [data-key="down"]')
  check('candidate navigation retains the real-time keyboard', `${inputs}.endsWith(String.fromCharCode(27) + '[B') && ${rawFocused}`)
  run('click', '#complete-input')
  check('completion sends Tab without executing the command', `${inputs}.endsWith(String.fromCharCode(9)) && !${inputs}.includes(String.fromCharCode(13)) && ${rawFocused}`)
  run('click', '#send')
  check('confirmation sends exactly one Enter and retains keyboard focus', `${inputs}.split(String.fromCharCode(13)).length === 2 && ${rawFocused}`)

  run('click', '#keyboard')
  resetInputs()
  run('fill', '#compose', '/effort')
  check('slash draft labels the first action as preview', `document.querySelector('#send').getAttribute('aria-label').includes('不发送回车') && document.querySelector('#completion-help').textContent.includes('先查看候选')`)
  capture('01-slash-draft')
  run('click', '#send')
  check('slash draft is transferred once without Enter or a duplicate slash', `${inputs} === '/effort' && document.querySelector('#compose').value === '' && ${rawFocused}`)
  run('click', '#send')
  check('a second tap confirms the existing terminal command', `${inputs} === '/effort' + String.fromCharCode(13) && ${rawFocused}`)

  run('click', '#keyboard')
  resetInputs()
  run('fill', '#compose', '/pl')
  run('click', '#special-keys [data-key="tab"]')
  check('original Tab key transfers an unsent prefix before completion', `${inputs} === '/pl' + String.fromCharCode(9) && document.querySelector('#compose').value === '' && ${rawFocused}`)
  run('click', '#complete-input')
  check('repeated completion never resends the transferred prefix', `${inputs} === '/pl' + String.fromCharCode(9, 9)`)

  run('click', '#keyboard')
  resetInputs()
  run('fill', '#compose', 'git che')
  run('click', '#complete-input')
  check('ordinary shell prefixes can be completed without executing them', `${inputs} === 'git che' + String.fromCharCode(9) && ${rawFocused}`)

  run('click', '#keyboard')
  resetInputs()
  run('fill', '#compose', 'cd tmp')
  run('click', '#more-keys')
  run('wait', '300')
  run('click', '#keys-dialog [data-text="/"]')
  check('slash inside a command edits the local draft at its caret', `document.querySelector('#compose').value === 'cd tmp/' && ${inputs} === ''`)
  run('fill', '#compose', '')
  run('click', '#slash-command')
  check('empty-draft slash shortcut also opens interactive skill input', `${inputs} === '/' && ${rawFocused}`)

  run('click', '#keyboard')
  resetInputs()
  run('fill', '#compose', '/技能')
  evaluate(`document.querySelector('#compose').dispatchEvent(new CompositionEvent('compositionstart')); document.querySelector('#compose-form').requestSubmit(); document.querySelector('#special-keys [data-key="tab"]').click()`)
  check('IME composition cannot submit or transfer partial text', `${inputs} === '' && document.querySelector('#compose').value === '/技能' && document.querySelector('#slash-command').disabled && document.querySelector('#complete-input').disabled`)
  evaluate(`document.querySelector('#compose').dispatchEvent(new CompositionEvent('compositionend'))`)
  run('click', '#send')
  check('committed Chinese skill text is transferred intact without Enter', `${inputs} === '/技能' && ${rawFocused}`)
  resetInputs()
  evaluate(`window.__completionTerm.textarea.dispatchEvent(new CompositionEvent('compositionstart')); document.querySelector('#compose-form').requestSubmit(); document.querySelector('#special-keys [data-key="tab"]').click()`)
  check('real-time IME composition also blocks confirmation and completion', `${inputs} === '' && document.querySelector('#complete-input').disabled`)
  evaluate(`window.__completionTerm.textarea.dispatchEvent(new CompositionEvent('compositionend'))`)

  run('click', '#keyboard')
  resetInputs()
  run('fill', '#compose', 'echo one\necho two')
  check('multiline drafts disable completion controls', `document.querySelector('#slash-command').disabled && document.querySelector('#complete-input').disabled`)
  evaluate(`document.querySelector('#special-keys [data-key="tab"]').click()`)
  check('original Tab also preserves multiline drafts', `${inputs} === '' && document.querySelector('#compose').value.includes(String.fromCharCode(10))`)
  run('fill', '#compose', 'echo 中文')
  run('click', '#send')
  check('ordinary commands still submit once with Enter', `${inputs} === 'echo 中文' + String.fromCharCode(13)`)

  for (const [name, width, height] of [['phone', 390, 844], ['narrow', 320, 640], ['keyboard', 390, 460], ['landscape', 844, 390]]) {
    run('set', 'viewport', String(width), String(height))
    evaluate(`if (document.querySelector('#special-keys').hidden) document.querySelector('#toggle-keys').click()`)
    check(`${name}: completion and send controls fit with useful terminal space`, `(() => {
      const controls = [...document.querySelectorAll('#special-keys button, #send')].map(el => el.getBoundingClientRect());
      const output = document.querySelector('#viewport').getBoundingClientRect();
      const keys = document.querySelector('#special-keys').getBoundingClientRect();
      const send = document.querySelector('#send').getBoundingClientRect();
      return output.height >= 100 && controls.every(r => r.width >= 44 && r.height >= 44 && r.bottom <= innerHeight) && keys.left >= 0 && keys.right <= innerWidth && send.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    })()`)
    capture(`02-${name}`)
  }
  const errors = JSON.parse(run('errors', '--json'))
  if (errors.data?.errors?.length) throw new Error(JSON.stringify(errors.data.errors))
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure') } catch { /* Keep the original failure. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  writeFileSync(resolve(directory, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机命令与技能补全验收</title><h1>手机命令与技能补全验收</h1><p>真实 Android Web 资产与 xterm，内存 RPC；不含真机和 Claude/OpenCode 验收。</p><ul>${results.map(item => `<li>${item.passed ? '通过' : '失败'}：${escape(item.name)}</li>`).join('')}</ul></html>`)
  try { run('close') } catch { /* Browser may already be closed. */ }
}
console.log(`${results.filter(item => item.passed).length}/${results.length} browser checks passed. ${directory}`)
