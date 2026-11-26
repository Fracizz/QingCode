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
const single = '#project-list .project-row'
const windowsPath = String.raw`D:\development\shared worktrees\android companion\a-long-project-directory\django`

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  run('eval', `localStorage.clear(); localStorage.setItem('qingcode:mobile:motion', 'reduce'); location.reload()`)
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
  check('home no longer shows a recent projects section', `!document.querySelector('#home-projects') && !document.querySelector('#home-project-list')`)
  run('wait', '--fn', `document.querySelector('#home-session-overview [data-project="win-remote"]')`)
  // 单条搜索结果不分组，来源直接显示在行内，用来验证项目行的小屏布局与快捷操作。
  run('click', '#dashboard-nav [data-page="project"]')
  run('fill', '#search', '252.107')
  run('set', 'viewport', '320', '780')
  check('320px project row gives the complete path a full-width line below the 44px actions', `(() => {
    const row = document.querySelector('${single}');
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
  run('wait', '300')
  run('screenshot', resolve(directory, 'project-row-320.png'))
  run('click', `${single} .project-new-terminal`)
  check('plus opens the correct project terminal profiles', `document.querySelector('#new-session-dialog').open &&
    document.querySelector('#new-session-context').textContent === 'django · 远端 · WinDev'`)
  run('press', 'Escape')
  run('click', `${single} .project-files`)
  check('file shortcut opens the project file browser', `document.querySelector('#files-dialog').open &&
    document.querySelector('#files-context').textContent.includes('django')`)
  run('press', 'Escape')
  run('eval', `(() => {
    const row = document.querySelector('${single} .project-open');
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
  })()`)
  const copy = `${single} .project-copy`
  check('long press reveals copy', hittable(copy))
  run('click', copy)
  check('copy preserves the complete display path', `window.__mobileFixture.state.clipboard === ${JSON.stringify(windowsPath)}`)

  run('set', 'viewport', '390', '844')
  run('fill', '#search', '')
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
  check('the group header uses the project-row plus and folder buttons at 320px', `(() => {
    const group = document.querySelector('${winGroup}');
    if (!group || document.querySelector('#home-sessions').hidden) return false;
    const enter = group.querySelector('.session-group-open').getBoundingClientRect();
    const add = group.querySelector('.session-group-add');
    const files = group.querySelector('.session-group-files');
    const addRect = add.getBoundingClientRect();
    const filesRect = files.getBoundingClientRect();
    const center = rect => (rect.top + rect.bottom) / 2;
    return add.querySelector('use').getAttribute('href') === '#i-plus' && files.querySelector('use').getAttribute('href') === '#i-folder' &&
      files.getAttribute('aria-label') === '浏览 django 的文件' && enter.height >= 44 &&
      addRect.width >= 44 && addRect.height >= 44 && filesRect.width >= 44 && filesRect.height >= 44 &&
      Math.abs(center(addRect) - center(filesRect)) < 1 && enter.right <= addRect.left && addRect.right <= filesRect.left &&
      filesRect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  check('the session count stays with a long source when they wrap under the project name', `(() => {
    const group = document.querySelector('#home-session-overview .session-group[data-project="wsl-remote"]');
    if (!group) return false;
    const name = group.querySelector('strong').getBoundingClientRect();
    const source = group.querySelector('.project-source-chip').getBoundingClientRect();
    const count = group.querySelector('.session-group-count').getBoundingClientRect();
    return name.bottom <= source.top && source.top < count.bottom && count.top < source.bottom && source.right < count.left;
  })()`)
  check('removed projects keep their group labels with project actions unavailable', `document.querySelector('${removed} .session-group-open')?.disabled && document.querySelector('${removed} .session-group-add').hidden && document.querySelector('${removed} .session-group-files').hidden`)
  run('screenshot', resolve(directory, 'home-project-actions-320.png'))
  run('eval', `(select => { select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })) })(document.querySelector('#app-language'))`)
  check('English header actions stay readable on a narrow screen', `(() => {
    const files = document.querySelector('${winGroup} .session-group-files');
    const source = document.querySelector('${winGroup} .project-source-chip');
    return files.getAttribute('aria-label') === 'Browse files in django' &&
      source.textContent === 'WinDev' && source.scrollWidth === source.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  })()`)
  run('eval', `(select => { select.value = 'zh'; select.dispatchEvent(new Event('change', { bubbles: true })) })(document.querySelector('#app-language'))`)
  run('click', '#home-sessions .overview-manage')
  check('manage mode hides project actions', `document.querySelector('${winGroup} .session-group-open').disabled && document.querySelector('${winGroup} .session-group-add').hidden && document.querySelector('${winGroup} .session-group-files').hidden`)
  run('click', '#home-sessions .overview-manage')
  run('click', `${winGroup} .session-group-open strong`)
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
  run('eval', `window.__mobileFixture.addDesktopTerminal({ id: 'desktop-codex', project: 'local', title: 'Codex' });
    window.__mobileFixture.pushScreen('desktop-codex', 'Codex local prompt');
    window.qingBack()`)
  const codex = '#home-session-overview [data-id="desktop-codex"] .row'
  run('wait', '--fn', `document.querySelector('${codex}')`)
  run('eval', `(() => {
    const request = window.QingCodeNative.request;
    window.__localListReads = 0;
    window.QingCodeNative.request = (id, payload) => {
      const args = JSON.parse(payload);
      if (args.op === 'sessions' && args.project === 'local') window.__localListReads++;
      if (args.op === 'poll' && args.id === 'desktop-codex' && !window.__deliverFirstScreen) {
        window.__deliverFirstScreen = () => request(id, payload);
        return;
      }
      request(id, payload);
    };
    performance.clearMeasures('qingcode.terminal.first-screen');
  })()`)
  run('click', codex)
  check('local desktop Codex starts attaching from the home list without another project lookup',
    `window.__deliverFirstScreen && window.__localListReads === 0 && document.querySelector('#terminal-status').textContent === '正在接入终端…' && document.querySelector('#send').disabled`)
  run('eval', 'window.__deliverFirstScreen()')
  check('Codex output is visible and its first screen has a timing entry',
    `${ready} && window.__mobileFixture.terminalText().includes('Codex local prompt') && performance.getEntriesByName('qingcode.terminal.first-screen').length === 1`)
  run('eval', 'window.qingBack()')
  check('the resume card points to the last local Codex session', `document.querySelector('#resume-name').textContent === 'Codex'`)
  run('click', '#resume')
  check('resuming local Codex reuses its ID without creating or listing sessions again',
    `${ready} && document.querySelector('#terminal-name').textContent.includes('Codex') && window.__localListReads === 0 && window.__mobileFixture.state.creates.length === window.__homeCreates + 1`)

} catch (error) {
  results.push({ passed: false, error: String(error) })
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify(results, null, 2))
  try { run('close') } catch { /* Keep the original failure in the report. */ }
  console.log(JSON.stringify({ results, directory }, null, 2))
}
