import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// pnpm dev:web-test (38419): real settings components and isolated memory IPC.
const session = `settings-categories-${process.pid}`
const directory = resolve('.dev/web-tests/settings-categories')
mkdirSync(directory, { recursive: true })
const results = []
const browser = process.env.AGENT_BROWSER_BIN || 'agent-browser'
const run = (...args) => execFileSync(browser, ['--session', session, ...args], {
  encoding: 'utf8', timeout: 30000,
})
const click = name => run('find', 'role', 'button', 'click', '--name', name, '--exact')
const category = name => {
  const index = Number(run('eval', `[...document.querySelectorAll('.settings-nav button')].findIndex(e=>e.textContent===${JSON.stringify(name)})`).trim())
  if (!Number.isInteger(index) || index < 0) throw new Error(`Missing settings category: ${name}`)
  run('scrollintoview', `.settings-nav button:nth-child(${index + 1})`)
  run('click', `.settings-nav button:nth-child(${index + 1})`)
}
const search = value => run('find', 'placeholder', '搜索设置', 'fill', value)
const check = (name, expression) => {
  run('wait', '--fn', `Boolean(${expression})`)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(directory, `${name}.png`))
const headings = `JSON.stringify([...document.querySelectorAll('.settings-content h2')].map(e=>e.textContent))`
const categories = ['外观与语言', '编辑器与文件', '终端', '项目与会话', '远程连接', '移动连接', '工具与集成', '快捷键', '更新与关于']

try {
  // Windows-only mobile UI is exercised on Linux; no native desktop identity.
  execFileSync(browser, ['--session', session, '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'open', `http://127.0.0.1:38419/?testSession=${session}`,
  ], { encoding: 'utf8', timeout: 30000 })
  run('wait', '--fn', 'Boolean(window.__QINGCODE_TEST__)')
  run('eval', `(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const status = {port:48764,savedPort:48764,configured:true,enabled:true,
      fingerprint:'0123456789abcdef'.repeat(4),devices:[],addresses:['192.0.2.8'],computer:'Fixture',error:null};
    window.__TAURI_INTERNALS__.invoke = async (command,args,...rest) => {
      if(command==='mobile_saved_settings') return {port:48764,configured:true,password:'fixture'};
      if(command==='mobile_status') return status;
      if(command==='mobile_pairing_qr') return {size:21,modules:'1'.repeat(441)};
      return original(command,args,...rest);
    }; return true;
  })()`)
  run('wait', '--fn', `Boolean(document.querySelector('button[aria-label="设置"]'))`)
  run('wait', '--fn', `!document.querySelector('#startup-splash') || getComputedStyle(document.querySelector('#startup-splash')).pointerEvents==='none'`)
  click('打开项目')
  click('信任并继续')
  click('设置')
  run('set', 'viewport', '1440', '1000')
  check('nine categories and appearance as the default', `${headings}==='["外观与语言"]' && document.querySelectorAll('.settings-nav button').length===9`)
  check('interface font belongs to appearance', `!!document.querySelector('[aria-label="界面字体"]') && !document.querySelector('[aria-label="编辑器: 小地图"]')`)
  capture('appearance')
  for (const name of categories) {
    category(name)
    check(`only ${name} is displayed`, `${headings}===${JSON.stringify(JSON.stringify([name]))} && document.querySelector('.settings-nav [aria-current="page"]').textContent===${JSON.stringify(name)}`)
  }
  category('终端')
  run('eval', `document.querySelector('.settings-content').scrollTop=500`)
  category('编辑器与文件')
  check('category switch starts at the top', `document.querySelector('.settings-content').scrollTop===0`)
  search('字体')
  check('global search returns matching rows from three categories', `${headings}==='["外观与语言","编辑器与文件","终端"]' && !document.querySelector('[aria-label="编辑器: 小地图"]') && !document.querySelector('[aria-label="终端 › 集成: SSH 粘贴上传"]')`)
  capture('global-font-search')
  category('终端')
  check('selecting a search category clears search and restores its full content', `document.querySelector('[placeholder="搜索设置"]').value==='' && ${headings}==='["终端"]' && !!document.querySelector('[aria-label="终端 › 集成: SSH 粘贴上传"]')`)
  search('ssh.server.offlineDir')
  check('configuration key search finds remote settings', `${headings}==='["远程连接"]' && document.querySelector('.settings-content').textContent.includes('离线')`)
  search('二维码')
  check('mobile aliases find the independent mobile category', `${headings}==='["移动连接"]' && !!document.querySelector('#mobile-connection-port')`)
  search('Ctrl+Shift+G')
  check('shortcut bindings filter individual commands', `!!document.querySelector('input[aria-label="切换小地图"]') && !document.querySelector('input[aria-label="打开命令面板"]')`)
  run('eval', `(async()=>{const {useShortcutStore}=await import('/src/store/shortcutStore.ts');useShortcutStore.setState({shortcuts:{...useShortcutStore.getState().shortcuts,quickOpen:'Alt+Q'}});return true})()`)
  search('Alt+Q')
  check('custom shortcut bindings are searchable', `!!document.querySelector('input[aria-label="快速打开文件"]') && !document.querySelector('input[aria-label="切换小地图"]')`)
  search('no-setting-matches')
  check('empty search explains the result', `document.querySelector('.settings-content [role="status"]').textContent.includes('没有匹配')`)
  run('click', '.settings-content [role="status"] button')
  check('clearing search restores the selected category and input focus', `${headings}==='["终端"]' && document.activeElement.getAttribute('placeholder')==='搜索设置'`)
  category('工具与集成')
  run('find', 'role', 'tab', 'click', '--name', '当前项目', '--exact')
  check('project scope shows only editable categories and falls back safely', `JSON.stringify([...document.querySelectorAll('.settings-nav button')].map(e=>e.textContent))==='["编辑器与文件","终端","远程连接"]' && ${headings}==='["编辑器与文件"]'`)
  category('终端')
  check('project terminal scope hides global font and shell controls', `!document.querySelector('[aria-label="终端 › 集成: 字体族"]') && !document.querySelector('[aria-label="终端 › 集成: 默认 Shell"]') && !!document.querySelector('[aria-label="终端 › 集成: SSH 粘贴上传"]')`)
  run('find', 'role', 'tab', 'click', '--name', '用户', '--exact')
  category('工具与集成')
  run('find', 'role', 'tab', 'click', '--name', '当前项目', '--exact')
  run('find', 'role', 'tab', 'click', '--name', '用户', '--exact')
  check('returning to user scope restores its last selected category', `${headings}==='["工具与集成"]'`)
  run('set', 'viewport', '800', '900')
  run('eval', `(async()=>{const m=await import('/src/lib/fontSettings.ts');m.applyFontSettings({...m.loadFontSettings(),interfaceFontSize:20});return true})()`)
  category('移动连接')
  check('narrow large-font mobile page stays within its container', `document.querySelector('.settings-body').scrollWidth<=document.querySelector('.settings-body').clientWidth+1 && document.documentElement.scrollWidth<=innerWidth`)
  capture('mobile-narrow-large-font')
  category('快捷键')
  check('narrow shortcut rows stay within the content column', `[...document.querySelectorAll('.shortcut-setting-row')].every(e=>e.scrollWidth<=e.clientWidth+1)`)
  capture('shortcuts-narrow-large-font')
  run('eval', `(async()=>{const m=await import('/src/lib/i18n.ts');await m.ensureBuiltinLocaleLoaded('en');m.useLocaleStore.setState({language:'en'});document.documentElement.dataset.theme='light';return true})()`)
  check('English category names are translated', `document.querySelector('.settings-nav').textContent.includes('Appearance and Language') && document.querySelector('.settings-nav').textContent.includes('Tools and Integrations')`)
  category('Keyboard Shortcuts')
  check('English category names wrap without truncation', `[...document.querySelectorAll('.settings-nav button')].every(e=>getComputedStyle(e).whiteSpace==='normal' && e.scrollWidth<=e.clientWidth+1)`)
  capture('english-light-narrow')
  run('eval', `(async()=>{const m=await import('/src/lib/i18n.ts');m.useLocaleStore.setState({language:'zh-CN'});const f=await import('/src/lib/fontSettings.ts');f.applyFontSettings({...f.loadFontSettings(),interfaceFontSize:13});return true})()`)
  run('set', 'viewport', '1440', '1000')
  run('eval', `(async()=>{const {useUIStore}=await import('/src/store/uiStore.ts');useUIStore.getState().requestSettings('终端配置');return true})()`)
  check('terminal profile deep link still opens the matching controls', `${headings}==='["终端"]' && !!document.querySelector('[aria-label="终端配置"]')`)
  click('管理设置')
  check('JSON and template actions are in management', `document.querySelector('[role="menu"]').textContent.includes('打开设置 JSON') && document.querySelector('[role="menu"]').textContent.includes('写入默认模板并打开')`)
  run('find', 'role', 'menuitem', 'click', '--name', '打开设置 JSON', '--exact')
  check('user JSON opens in the editor', `!document.querySelector('.settings-shell') && [...document.querySelectorAll('[role="tab"]')].some(e=>e.textContent.includes('default-settings.json'))`)
  click('设置')
  run('find', 'role', 'tab', 'click', '--name', '当前项目', '--exact')
  click('管理设置')
  run('find', 'role', 'menuitem', 'click', '--name', '写入默认模板并打开', '--exact')
  check('project template opens in the editor with comments', `!document.querySelector('.settings-shell') && window.__QINGCODE_TEST__.readFile('/workspace/demo/.qingcode/project-settings.json').includes('不得删除注释')`)
} catch (error) {
  results.push({ name: String(error), passed: false })
  process.exitCode = 1
  try { capture('failure'); writeFileSync(resolve(directory, 'failure.txt'), run('snapshot', '-i')) } catch {}
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  try { writeFileSync(resolve(directory, 'browser-errors.json'), run('errors', '--json')); run('close') } catch {}
  const escaped = JSON.stringify(results, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  writeFileSync(resolve(directory, 'report.html'), `<!doctype html><meta charset="UTF-8"><title>设置分类验收</title><h1>QingCode 设置分类验收</h1><p>Linux agent-browser，固定内存数据；未验证 Windows 原生界面、真实文件、SSH 或手机连接。</p><pre>${escaped}</pre>`)
  console.log(`${results.filter(result => result.passed).length}/${results.length} settings checks passed. ${directory}`)
}
