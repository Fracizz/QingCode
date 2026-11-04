import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-sources-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-project-sources')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], {
  encoding: 'utf8', timeout: 30000,
})
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const sources = `[...document.querySelectorAll('#project-list .project-source')].map(node => node.textContent)`

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  run('eval', `localStorage.clear(); location.reload()`)
  check('fixture starts ready', `!!window.__mobileFixture && typeof window.qingLink === 'function'`)
  run('eval', `window.__mobileFixture.state.projects = [
    { id: 'wsl-remote', name: 'django', kind: 'ssh', host: 'localhost', connectionName: 'WSL', path: 'ssh://wsl/home/code/django' },
    { id: 'win-remote', name: 'django', kind: 'ssh', host: '192.168.252.107', connectionName: 'WinDev', path: 'ssh://win/D:/code/django' },
    { id: 'legacy', name: 'api-server', kind: 'ssh', host: 'build.example', path: 'ssh://old/srv/api' },
    { id: 'native-wsl', name: 'local-linux', kind: 'wsl', host: 'Ubuntu', path: 'wsl://Ubuntu/home/code/app' },
    { id: 'local', name: 'QingCode', kind: 'local', host: 'Windows', path: 'D:/code/QingCode' }
  ]; window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))`)
  check('pairing link opens', `document.getElementById('pair-dialog').open`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('computer connects', `document.getElementById('active-host').dataset.state === 'online'`)
  run('click', '#dashboard-nav [data-page="project"]')
  check('all sources have their own line above the path', `document.querySelectorAll('#project-list .row').length === 5 &&
    ${sources}.includes('远端 · WSL · localhost') && ${sources}.includes('远端 · WinDev · 192.168.252.107') &&
    document.querySelector('#project-list .project-path').textContent === '/home/code/django'`)
  check('project list uses search without environment categories', `!document.querySelector('#hosts')`)
  run('wait', '100')
  run('screenshot', resolve(directory, 'remote-sources.png'))
  run('fill', '#search', 'wSl')
  check('connection name search identifies WSL remote projects', `document.querySelectorAll('#project-list .row').length === 2 &&
    ${sources}[0] === '远端 · WSL · localhost'`)
  run('click', '#project-list .row:first-child')
  check('terminal header keeps source and address', `document.getElementById('terminal-status').textContent === '会话中' &&
    document.getElementById('terminal-host').textContent === 'DEVBOX / 远端 · WSL · localhost'`)
  run('click', '#back')
  run('click', '#dashboard-nav [data-page="home"]')
  check('resume card keeps source and address', `document.getElementById('resume-host').textContent === 'DEVBOX / 远端 · WSL · localhost'`)
  run('click', '#dashboard-nav [data-page="project"]')
  run('fill', '#search', '252.107')
  check('address search distinguishes same-name projects', `document.querySelectorAll('#project-list .row').length === 1 &&
    ${sources}[0] === '远端 · WinDev · 192.168.252.107'`)
  run('fill', '#search', 'build.example')
  check('older desktops still show the host without a connection name', `${sources}[0] === '远端 · build.example'`)
  run('fill', '#search', '')
  run('fill', '#search', 'Ubuntu')
  check('native WSL can be found by distribution', `document.querySelectorAll('#project-list .row').length === 1 && ${sources}[0] === 'WSL · Ubuntu'`)
  run('fill', '#search', '/home/code/django')
  check('path search includes remote WSL projects', `document.querySelectorAll('#project-list .row').length === 1 && ${sources}[0] === '远端 · WSL · localhost'`)
  run('fill', '#search', '')
  run('eval', `window.__mobileFixture.state.projects[0].connectionName = '用于多个项目的很长的 WSL 连接名称'`)
  run('click', '#refresh')
  run('set', 'viewport', '320', '780')
  check('long source names wrap without hiding the address or causing horizontal scroll', `(() => {
    const source = document.querySelector('#project-list .project-source');
    return source.textContent.endsWith('localhost') && getComputedStyle(source).whiteSpace === 'normal' &&
      source.scrollWidth <= source.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  run('wait', '100')
  run('screenshot', resolve(directory, 'long-source-narrow.png'))
} catch (error) {
  results.push({ passed: false, error: String(error) })
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify(results, null, 2))
  try { run('close') } catch { /* Keep the original failure in the report. */ }
  console.log(JSON.stringify({ results, directory }, null, 2))
}
