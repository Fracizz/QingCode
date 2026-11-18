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
const settled = id => `document.getElementById('${id}').open && !document.getElementById('${id}').getAnimations().some(animation => animation.playState === 'running')`
const hittable = selector => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
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
  ]; window.__winSession = window.__mobileFixture.addSession({ project: 'win-remote' });
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

  const winGroup = '#home-session-overview .session-group[data-project="win-remote"]'
  const removed = '#home-session-overview .session-group[data-project="removed"]'
  const ready = `document.querySelector('#terminal-status').textContent === '会话中'`
  run('eval', `const fixture = window.__mobileFixture;
    fixture.addSession({ project: 'removed', projectInfo: { id: 'removed', name: '已移除的测试项目', kind: 'local' } });
    window.__homeCreates = fixture.state.creates.length`)
  run('click', '#dashboard-nav [data-page="home"]')
  check('the open project label and plus align without clipping at 320px', `(() => {
    const group = document.querySelector('${winGroup}');
    if (!group || document.querySelector('#home-sessions').hidden) return false;
    const enter = group.querySelector('.session-group-open');
    const label = group.querySelector('.session-group-open-label');
    const labelRect = label.getBoundingClientRect();
    const add = group.querySelector('.session-group-add').getBoundingClientRect();
    const center = rect => (rect.top + rect.bottom) / 2;
    return label.textContent === '打开项目' && label.scrollWidth === label.clientWidth &&
      getComputedStyle(label).color === getComputedStyle(document.querySelector('#home-all-projects')).color &&
      enter.offsetHeight >= 44 && add.width >= 44 && add.height >= 44 && Math.abs(center(labelRect) - center(add)) < 1 &&
      labelRect.right <= add.left && add.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  check('the session count stays with a long source when they wrap under the project name', `(() => {
    const group = document.querySelector('#home-session-overview .session-group[data-project="wsl-remote"]');
    if (!group) return false;
    const name = group.querySelector('strong').getBoundingClientRect();
    const source = group.querySelector('.project-source-chip').getBoundingClientRect();
    const count = group.querySelector('.session-group-count').getBoundingClientRect();
    return name.bottom <= source.top && source.top < count.bottom && count.top < source.bottom && source.right < count.left;
  })()`)
  check('removed projects keep their group labels with project actions unavailable', `document.querySelector('${removed} .session-group-open')?.disabled && document.querySelector('${removed} .session-group-open-label').hidden && document.querySelector('${removed} .session-group-add').hidden`)
  run('screenshot', resolve(directory, 'home-project-actions-320.png'))
  run('eval', `document.querySelector('#app-language [data-locale="en"]').click()`)
  check('English action stays readable on a narrow screen', `(() => {
    const label = document.querySelector('${winGroup} .session-group-open-label');
    const source = document.querySelector('${winGroup} .project-source-chip');
    return label.textContent === 'Open project' && label.scrollWidth === label.clientWidth &&
      source.textContent === 'WinDev' && source.scrollWidth === source.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  run('eval', `document.querySelector('#app-language [data-locale="zh"]').click()`)
  run('click', '#home-sessions .overview-manage')
  check('manage mode hides project actions', `document.querySelector('${winGroup} .session-group-open').disabled && document.querySelector('${winGroup} .session-group-open-label').hidden && document.querySelector('${winGroup} .session-group-add').hidden`)
  run('click', '#home-sessions .overview-manage')
  run('click', `${winGroup} .session-group-open-label`)
  check('the header opens the existing session in the matching project', `${ready} && document.querySelector('#terminal-host').textContent === 'django · WinDev' && localStorage.getItem('qingcode:mobile:session:192.168.1.8:48764:win-remote') === window.__winSession && window.__mobileFixture.state.creates.length === window.__homeCreates`)

  run('click', '#terminal-menu')
  run('wait', '--fn', `${settled('terminal-menu-dialog')} && ${hittable('#manage-sessions')}`)
  run('click', '#manage-sessions')
  run('wait', '--fn', `document.querySelector('#session-dialog').open`)
  run('eval', `for (let i = 0; i < 8; i++) document.querySelector('#font-smaller').click()`)
  check('the terminal applies and saves 8px and cannot shrink further', `window.__mobileFixture.terminalFontSize() === 8 && localStorage.getItem('qingcode:mobile:font-size') === '8' && document.querySelector('#font-smaller').disabled`)
  run('eval', 'window.qingBack(); window.qingBack()')
  run('click', `${winGroup} .session-group-add`)
  check('home plus opens terminal profiles for its own project', `document.querySelector('#new-session-dialog').open && document.querySelector('#new-session-context').textContent === 'django · 远端 · WinDev' && window.__mobileFixture.state.creates.length === window.__homeCreates`)
  run('eval', 'window.qingBack()')
  check('cancel returns to the home list with the original sessions', `!document.querySelector('#new-session-dialog').open && !document.querySelector('#home-screen').hidden && window.__mobileFixture.state.creates.length === window.__homeCreates`)
  run('click', `${winGroup} .session-group-add`)
  const claudeProfile = '#terminal-profiles [data-profile="claude"]'
  run('wait', '--fn', `${settled('new-session-dialog')} && ${hittable(claudeProfile)}`)
  run('click', claudeProfile)
  check('the selected profile creates one terminal in the target project and keeps the saved font', `${ready} && window.__mobileFixture.state.creates.length === window.__homeCreates + 1 && window.__mobileFixture.state.creates.at(-1).project === 'win-remote' && window.__mobileFixture.state.creates.at(-1).terminalProfile === 'claude' && window.__mobileFixture.terminalFontSize() === 8`)
} catch (error) {
  results.push({ passed: false, error: String(error) })
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify(results, null, 2))
  try { run('close') } catch { /* Keep the original failure in the report. */ }
  console.log(JSON.stringify({ results, directory }, null, 2))
}
