import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-images-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-images')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const openImage = () => { run('click', '#attach-image'); run('wait', '300') }
const newSession = launch => {
  run('click', '#new-session')
  run('wait', '300')
  run('click', `[data-launch="${launch}"]`)
}

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  run('eval', 'localStorage.clear(); location.reload()')
  check('fixture loads', `!!window.__mobileFixture && typeof window.qingLink === 'function'`)
  run('eval', `window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('paired', `document.querySelector('#active-host').dataset.state === 'online'`)
  run('click', '#dashboard-nav [data-page="project"]')
  check('bottom bar is compact and reaches the bottom', `(() => { const r = document.querySelector('#dashboard-nav').getBoundingClientRect(); return r.height <= 56 && r.bottom === innerHeight; })()`)
  run('click', '#project-list .row:first-child')
  check('terminal ready', `document.querySelector('#terminal-status').textContent === '会话中'`)
  run('eval', `window.__imageTest = { original: document.querySelector('#session-tabs [aria-current]').textContent, inputCount: window.__mobileFixture.state.inputs.length }`)
  newSession('claude')
  check('Claude starts once in a separate session', `window.__mobileFixture.state.sessions.size === 2 && window.__mobileFixture.state.inputs.filter(value => value === 'claude' + String.fromCharCode(13)).length === 1`)
  newSession('opencode')
  check('OpenCode starts once and keeps existing sessions', `window.__mobileFixture.state.sessions.size === 3 && window.__mobileFixture.state.inputs.filter(value => value === 'opencode' + String.fromCharCode(13)).length === 1`)
  check('new terminal accepts input', `!document.querySelector('#attach-image').disabled`)
  openImage()
  check('medium compression is the default', `document.querySelector('#image-compression').value === 'medium'`)
  run('wait', '100')
  run('screenshot', resolve(directory, 'image-settings.png'))
  run('eval', 'window.__mobileFixture.state.image = null')
  run('click', '#choose-image')
  check('cancelling the system picker keeps the draft and uploads nothing', `!document.querySelector('#choose-image').disabled && document.querySelector('#compose').value === '' && window.__mobileFixture.state.images.length === 0`)
  run('eval', `window.__mobileFixture.state.image = { data: btoa(String.fromCharCode(255,216,255,0)) }`)
  run('click', '#choose-image')
  check('image uploads once using medium compression and inserts a path without submitting', `!document.querySelector('#image-dialog').open && document.querySelector('#compose').value === "'/tmp/mobile-image.jpg' " && window.__mobileFixture.state.images.length === 1 && window.__mobileFixture.state.imageCompression === 'medium' && window.__mobileFixture.state.inputs.length === window.__imageTest.inputCount + 2`)
  run('fill', '#compose', '请分析图片 ')
  openImage()
  run('select', '#image-compression', 'high')
  run('eval', `window.__mobileFixture.state.imageError = '图片不能超过 8 MB。'`)
  run('click', '#choose-image')
  check('failed upload keeps the draft and explains the error', `document.querySelector('#image-error').textContent.includes('8 MB') && document.querySelector('#compose').value === '请分析图片 ' && localStorage.getItem('qingcode:mobile:image-compression') === 'high'`)
  run('eval', `window.__mobileFixture.state.imageError = null; window.__mobileFixture.state.imageDelay = 1800`)
  run('click', '#choose-image')
  check('upload button blocks duplicate requests', `document.querySelector('#choose-image').disabled`)
  run('eval', `window.qingBack()`)
  run('click', '#session-tabs button:first-child')
  check('switching sessions restores the destination draft', `document.querySelector('#compose').value === ''`)
  run('wait', '2200')
  check('late image completion never inserts into another session', `document.querySelector('#compose').value === '' && !document.querySelector('#choose-image').disabled`)
  run('set', 'viewport', '320', '640')
  openImage()
  check('compression preference persists and the dialog fits a narrow phone', `document.querySelector('#image-compression').value === 'high' && document.querySelector('#image-dialog').getBoundingClientRect().right <= innerWidth - 11`)
  run('eval', 'window.qingBack()')
  run('eval', `document.documentElement.style.setProperty('--corner-inset', '28px')`)
  check('rounded corner inset protects terminal controls without a bottom spacer', `parseFloat(getComputedStyle(document.querySelector('#terminal-tools')).paddingLeft) === 28 && document.querySelector('#terminal-tools').getBoundingClientRect().bottom === innerHeight && document.documentElement.scrollWidth <= innerWidth`)
  run('wait', '100')
  run('screenshot', resolve(directory, 'terminal-rounded-320.png'))
} catch (error) {
  results.push({ passed: false, error: String(error) })
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ nativeIntegration: false, results }, null, 2))
  try { run('close') } catch { /* Preserve the original failure. */ }
  console.log(JSON.stringify({ results, directory }, null, 2))
}
