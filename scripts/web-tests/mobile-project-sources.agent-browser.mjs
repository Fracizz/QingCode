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
const hittable = selector => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  const { x, y, width, height } = element.getBoundingClientRect();
  return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
})()`
const sources = `[...document.querySelectorAll('#project-list .project-source')].map(node => node.textContent)`
const recent = '#home-project-list .project-row'
const windowsPath = String.raw`D:\development\shared worktrees\android companion\a-long-project-directory\django`

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  run('eval', `localStorage.clear(); location.reload()`)
  check('fixture starts ready', `!!window.__mobileFixture && typeof window.qingLink === 'function'`)
  run('eval', `window.__mobileFixture.state.projects = [
    { id: 'wsl-remote', name: 'django', kind: 'ssh', host: 'localhost', connectionName: 'WSL', path: 'ssh://wsl/home/code/django', lastOpenedAt: 3 },
    { id: 'win-remote', name: 'django', kind: 'ssh', host: '192.168.252.107', connectionName: 'WinDev', path: 'ssh://win/${windowsPath.replaceAll('\\', '/')}', lastOpenedAt: 2 },
    { id: 'legacy', name: 'api-server', kind: 'ssh', host: 'build.example', path: 'ssh://old/srv/api' },
    { id: 'native-wsl', name: 'local-linux', kind: 'wsl', host: 'Ubuntu', path: 'wsl://Ubuntu/home/code/app' },
    { id: 'local', name: 'QingCode', kind: 'local', host: 'Windows', path: 'D:/code/QingCode', lastOpenedAt: 1 }
  ]; window.__mobileFixture.addSession({ project: 'win-remote' });
  window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))`)
  check('pairing link opens', `document.getElementById('pair-dialog').open`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('computer connects', `document.getElementById('active-host').dataset.state === 'online'`)
  run('click', '#dashboard-nav [data-page="home"]')
  check('recent projects distinguish same-name projects without changing recency order', `(() => {
    const rows = [...document.querySelectorAll('${recent}')];
    return rows.length === 3 && rows[0].querySelector('.project-source').textContent === '远端 · WSL · localhost' &&
      rows[1].querySelector('.project-source').textContent === '远端 · WinDev · 192.168.252.107' &&
      rows[2].querySelector('.project-source').textContent === '本机';
  })()`)
  run('set', 'viewport', '320', '780')
  check('320px recent project gives the complete path a full-width line below the 44px actions', `(() => {
    const row = document.querySelectorAll('${recent}')[1];
    const path = row.querySelector('.project-path');
    const source = row.querySelector('.project-source');
    const count = row.querySelector('.project-session-count');
    const actions = [...row.querySelectorAll('.project-actions button')].map(node => node.getBoundingClientRect());
    return path.textContent === ${JSON.stringify(windowsPath)} && path.children.length > 2 &&
      path.offsetHeight > 2 * parseFloat(getComputedStyle(path).lineHeight) && path.scrollWidth === path.clientWidth &&
      path.getBoundingClientRect().right > actions[0].left && source.getBoundingClientRect().top >= actions[0].bottom &&
      actions.every(action => action.width === 44 && action.height === 44) && count?.textContent === '1 个会话' &&
      count.getBoundingClientRect().bottom <= path.getBoundingClientRect().top && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  run('eval', `document.querySelector('${recent}').scrollIntoView({ block: 'center' })`)
  run('wait', '300')
  run('screenshot', resolve(directory, 'recent-projects-320.png'))
  run('click', `${recent}:nth-child(2) .project-new-terminal`)
  check('plus opens the correct project terminal profiles', `document.querySelector('#new-session-dialog').open &&
    document.querySelector('#new-session-context').textContent === 'django · 远端 · WinDev'`)
  run('press', 'Escape')
  run('click', `${recent}:nth-child(2) .project-files`)
  check('file shortcut opens the project file browser', `document.querySelector('#files-dialog').open &&
    document.querySelector('#files-context').textContent.includes('django')`)
  run('press', 'Escape')
  run('eval', `(() => {
    const row = document.querySelectorAll('${recent}')[1].querySelector('.project-open');
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
  })()`)
  const copy = `${recent}:nth-child(2) .project-copy`
  check('long press reveals copy', hittable(copy))
  run('click', copy)
  check('copy preserves the complete display path', `window.__mobileFixture.state.clipboard === ${JSON.stringify(windowsPath)}`)

  run('set', 'viewport', '390', '844')
  run('click', '#dashboard-nav [data-page="project"]')
  check('group headings show sources and rows retain them for screen readers', `document.querySelectorAll('#project-list .project-group').length === 5 &&
    ${sources}.includes('远端 · WSL · localhost') && ${sources}.includes('远端 · WinDev · 192.168.252.107') &&
    document.querySelector('#project-list .project-source').classList.contains('sr-only') &&
    document.querySelector('#project-list .project-path').textContent === '/home/code/django'`)
  check('project list uses search without environment categories', `!document.querySelector('#hosts')`)
  run('wait', '100')
  run('screenshot', resolve(directory, 'remote-sources.png'))
  run('fill', '#search', 'wSl')
  check('connection name search identifies WSL remote projects', `document.querySelectorAll('#project-list .row').length === 2 &&
    ${sources}[0] === '远端 · WSL · localhost'`)
  run('click', '#project-list > :first-child .project-row:first-child .row')
  run('eval', 'window.__mobileFixture.startTerminalIfEmpty()')
  check('terminal header keeps source on one line without the address', `document.getElementById('terminal-status').textContent === '会话中' &&
    document.getElementById('terminal-host').textContent === 'django · WSL'`)
  run('click', '#show-sessions')
  run('wait', '--fn', hittable('#back'))
  run('click', '#back')
  run('click', '#dashboard-nav [data-page="home"]')
  check('recent row keeps source and address after opening a terminal', `document.querySelector('${recent} .project-source').textContent === '远端 · WSL · localhost'`)
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
  run('fill', '#search', '/home/code/django')
  run('set', 'viewport', '320', '780')
  check('long source names wrap without hiding the address or causing horizontal scroll', `(() => {
    const source = document.querySelector('#project-list .project-source');
    return source.textContent.includes('用于多个项目') && source.textContent.endsWith('localhost') && !source.classList.contains('sr-only') &&
      getComputedStyle(source).whiteSpace === 'normal' &&
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
