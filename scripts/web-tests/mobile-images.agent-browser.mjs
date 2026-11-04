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
const openSettings = () => { run('click', '#manage-sessions'); run('wait', '300') }
const openNewSession = () => {
  run('click', '#new-session')
  run('wait', '300')
}
const newSession = id => {
  openNewSession()
  run('click', `#new-session-dialog [data-profile="${id}"]`)
}
const creates = profileId => `window.__mobileFixture.state.creates.filter(item => item.terminalProfile === '${profileId}').length`

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
  run('eval', `window.__imageTest = { original: document.querySelector('#terminal-name').textContent, inputCount: window.__mobileFixture.state.inputs.length }`)
  check('first terminal uses the desktop default profile', `${creates('default')} === 1`)
  openNewSession()
  check('new-session choices come from the desktop terminal profiles', `[...document.querySelectorAll('#terminal-profiles button')].map(b => b.dataset.profile).join() === 'default,claude,opencode,deploy' && document.querySelector('#terminal-profiles [data-profile="deploy"] small')?.textContent.includes('信任')`)
  run('screenshot', resolve(directory, 'terminal-profiles.png'))
  run('click', '#new-session-dialog [data-profile="claude"]')
  check('Claude profile starts once in a separate session without typed input', `window.__mobileFixture.state.sessions.size === 2 && ${creates('claude')} === 1 && window.__mobileFixture.state.inputs.length === window.__imageTest.inputCount`)
  newSession('opencode')
  check('OpenCode profile starts once and keeps existing sessions', `window.__mobileFixture.state.sessions.size === 3 && ${creates('opencode')} === 1`)
  newSession('deploy')
  check('untrusted profile stays in the dialog with the desktop trust hint', `document.querySelector('#new-session-dialog').open && window.__mobileFixture.state.sessions.size === 3 && document.querySelector('#terminal-profiles-error').textContent.includes('信任此配置')`)
  run('click', '#new-session-dialog [data-close="new-session-dialog"]')
  run('eval', `window.__mobileFixture.state.terminalProfiles = [{ id: 'build', name: '构建', trusted: true }]`)
  newSession('build')
  check('profile list refreshes from the desktop on every open', `window.__mobileFixture.state.sessions.size === 4 && ${creates('build')} === 1`)
  check('new terminal accepts input', `!document.querySelector('#attach-image').disabled`)
  openSettings()
  check('compression lives in settings and defaults to medium', `document.querySelector('#session-dialog #image-compression').value === 'medium' && !document.querySelector('#image-dialog #image-compression')`)
  run('screenshot', resolve(directory, 'image-settings.png'))
  run('eval', 'window.qingBack()')
  run('fill', '#compose', '请分析图片 ')
  run('eval', 'window.__mobileFixture.state.image = null')
  run('click', '#attach-image')
  check('cancelling the direct system picker keeps the draft and uploads nothing', `!document.querySelector('#attach-image').disabled && !document.querySelector('#image-dialog').open && document.querySelector('#compose').value === '请分析图片 ' && window.__mobileFixture.state.images.length === 0`)
  run('eval', `window.__mobileFixture.state.image = { data: btoa(String.fromCharCode(255,216,255,0)) }`)
  run('click', '#attach-image')
  check('one tap uploads with saved compression and inserts a path without submitting', `!document.querySelector('#image-dialog').open && document.querySelector('#compose').value === "请分析图片 '/tmp/mobile-image.jpg' " && window.__mobileFixture.state.images.length === 1 && window.__mobileFixture.state.imageCompression === 'medium' && window.__mobileFixture.state.inputs.length === window.__imageTest.inputCount + 2`)
  run('fill', '#compose', '请分析图片 ')
  openSettings()
  run('select', '#image-compression', 'high')
  run('eval', 'window.qingBack()')
  run('eval', `window.__mobileFixture.state.imageError = '图片不能超过 8 MB。'`)
  run('click', '#attach-image')
  check('failure opens an error dialog and preserves the draft', `document.querySelector('#image-dialog').open && document.querySelector('#image-error').textContent.includes('8 MB') && document.querySelector('#compose').value === '请分析图片 ' && localStorage.getItem('qingcode:mobile:image-compression') === 'high'`)
  run('screenshot', resolve(directory, 'image-error.png'))
  run('eval', `window.__mobileFixture.state.imageError = null`)
  run('click', '#choose-image')
  check('retry succeeds using settings without another compression prompt', `!document.querySelector('#image-dialog').open && window.__mobileFixture.state.images.length === 2 && window.__mobileFixture.state.imageCompression === 'high' && document.querySelector('#compose').value.includes('/tmp/mobile-image.jpg')`)
  run('fill', '#compose', '保留原会话草稿 ')
  run('eval', `window.__mobileFixture.state.imageDelay = 1800`)
  run('click', '#attach-image')
  check('upload blocks duplicate requests', `document.querySelector('#attach-image').disabled && document.querySelector('#attach-image').getAttribute('aria-busy') === 'true' && document.querySelector('#image-state').textContent === '图片上传中…' && document.querySelector('#terminal-status').textContent === '会话中'`)
  run('click', '#show-sessions')
  run('click', '#session-options .session-option:first-child .row')
  check('switching sessions restores the destination draft', `document.querySelector('#compose').value === ''`)
  run('wait', '2200')
  check('late image completion never inserts into another session', `document.querySelector('#compose').value === '' && !document.querySelector('#attach-image').disabled`)
  run('click', '#show-sessions')
  run('click', '#session-options .session-option:last-child .row')
  check('late completion also leaves the source draft intact', `document.querySelector('#compose').value === '保留原会话草稿 '`)
  run('set', 'viewport', '320', '640')
  openSettings()
  check('saved compression and settings fit a narrow phone', `document.querySelector('#image-compression').value === 'high' && document.querySelector('#session-dialog').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth && document.querySelector('#image-compression-hint').textContent.includes('HEIC')`)
  run('screenshot', resolve(directory, 'image-settings-320.png'))
  run('eval', 'window.qingBack()')
  run('eval', `document.documentElement.style.setProperty('--corner-inset', '28px'); document.documentElement.style.setProperty('--corner-bottom-inset', '9px')`)
  check('rounded screen keeps terminal controls wide with a small bottom clearance', `getComputedStyle(document.querySelector('#terminal-tools')).paddingLeft === '8px' && getComputedStyle(document.querySelector('#terminal-tools')).paddingBottom === '9px' && document.querySelector('#terminal-tools').getBoundingClientRect().bottom === innerHeight && document.documentElement.scrollWidth <= innerWidth`)
  run('wait', '100')
  run('screenshot', resolve(directory, 'terminal-rounded-320.png'))
  run('reload')
  check('compression preference survives app reload', `document.querySelector('#image-compression').value === 'high'`)
} catch (error) {
  results.push({ passed: false, error: String(error) })
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ nativeIntegration: false, results }, null, 2))
  try { run('close') } catch { /* Preserve the original failure. */ }
  console.log(JSON.stringify({ results, directory }, null, 2))
}
