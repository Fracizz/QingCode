import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-workspace-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-workspace')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => { run('wait', '--fn', expression); results.push({ name, passed: true }) }
const capture = name => { run('wait', '300'); return run('screenshot', resolve(directory, `${name}.png`)) }
const menu = action => {
  run('wait', '300')
  run('click', '#terminal-menu')
  run('wait', '--fn', `document.querySelector('#terminal-menu-dialog').open && !document.querySelector('#terminal-menu-dialog').getAnimations().some(animation=>animation.playState==='running')`)
  run('click', '#menu-' + action)
  const target = { edit: 'expanded-dialog', submissions: 'submissions-dialog', read: 'reader-dialog', sessions: 'session-dialog', new: 'new-session-dialog' }[action]
  if (target) run('wait', '--fn', `document.querySelector('#${target}').open && !document.querySelector('#${target}').getAnimations().some(animation=>animation.playState==='running')`)
}
const close = id => evaluate(`document.querySelector('#${id}').close()`)
const pair = () => {
  evaluate(`window.qingLink(window.__mobileFixture.link('192.168.1.8',48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('paired computer is online', `document.querySelector('#active-host').dataset.state==='online'`)
  run('click', '#dashboard-nav [data-page="project"]')
  run('click', '#project-list .row:first-child')
  check('terminal is attached', `document.querySelector('#terminal-status').textContent==='会话中'`)
}
const fits = `document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('dialog[open]')].every(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1})`

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('real APK assets initialize', `typeof window.qingLink==='function' && typeof window.qingOrientation==='function'`)
  evaluate(`window.Terminal=class extends window.Terminal {constructor(...args){super(...args);window.__workspaceTerm=this}}`)
  pair()
  menu('edit')
  const prompt = '请分析这个模块\n保留中文、emoji 😀 和代码：\nconst total = price + tax;'
  run('fill', '#expanded-compose', prompt)
  check('expanded editor shares and persists the actual command draft', `document.querySelector('#compose').value===${JSON.stringify(prompt)} && localStorage.getItem('qingcode:mobile:workspace-state').includes('请分析这个模块')`)
  evaluate(`document.querySelector('#expanded-compose').dispatchEvent(new CompositionEvent('compositionstart'));document.querySelector('#expanded-send').click()`)
  check('Chinese composition prevents a premature submission', `document.querySelector('#expanded-dialog').open && window.__mobileFixture.state.inputs.length===0`)
  evaluate(`document.querySelector('#expanded-compose').dispatchEvent(new CompositionEvent('compositionend'))`)
  capture('01-expanded-editor')
  close('expanded-dialog')
  check('collapsing the editor retains all newlines', `document.querySelector('#compose').value===${JSON.stringify(prompt)}`)

  evaluate(`window.__realRequest=window.QingCodeNative.request; window.QingCodeNative.request=(id,payload)=>{
    const request=JSON.parse(payload);if(request.op==='input'){window.__pendingInput=()=>window.qingReply(id,{ok:true,data:null});return} window.__realRequest(id,payload)
  }`)
  run('click', '#send')
  check('submission stays pending until the computer acknowledges it', `document.querySelector('#compose').value==='' && document.querySelector('#submission-status').textContent.includes('正在发送') && typeof window.__pendingInput==='function'`)
  run('fill', '#compose', '另一个未发送草稿')
  evaluate('window.__pendingInput();window.QingCodeNative.request=window.__realRequest')
  check('acknowledgement never clears a newer draft', `document.querySelector('#submission-status').textContent.includes('电脑已接收') && document.querySelector('#compose').value==='另一个未发送草稿'`)
  run('click', '#review-submission')
  check('submission preview retains the exact original text', `document.querySelector('#submission-preview').value===${JSON.stringify(prompt)}`)
  run('click', '#copy-submission')
  check('original text copies to the native clipboard', `window.__mobileFixture.state.clipboard===${JSON.stringify(prompt)}`)
  run('click', '#restore-submission')
  check('manual recovery appends without overwriting the newer draft or sending', `document.querySelector('#expanded-compose').value===${JSON.stringify('另一个未发送草稿\n\n' + prompt)} && window.__mobileFixture.state.inputs.length===0`)
  close('expanded-dialog')

  evaluate(`window.QingCodeNative.request=(id,payload)=>{const request=JSON.parse(payload); if(request.op==='input'){setTimeout(()=>window.qingReply(id,{ok:false,error:'模拟弱网超时'}),50);return} window.__realRequest(id,payload)}`)
  run('fill', '#compose', '结果未知的请求')
  run('click', '#send')
  check('failed submission is retained with an unknown outcome', `document.querySelector('#submission-status').textContent.includes('结果未知')`)
  evaluate('window.QingCodeNative.request=window.__realRequest')
  run('click', '#review-submission')
  check('unknown submission is recoverable and never automatically resent', `document.querySelector('#submission-preview').value==='结果未知的请求' && window.__mobileFixture.state.inputs.length===0`)
  capture('02-unknown-submission')
  close('submissions-dialog')

  run('set', 'viewport', '844', '390')
  check('landscape enters immersive mode with an accessible menu', `window.__mobileFixture.state.fullscreen && document.querySelector('#terminal-menu').getBoundingClientRect().right<=innerWidth`)
  menu('sessions')
  check('session settings are accessible while the header is hidden', `document.querySelector('#session-dialog').open && ${fits}`)
  run('select', '#terminal-columns', '80')
  close('session-dialog')
  check('fixed columns resize the real terminal grid', `window.__workspaceTerm.cols===80`)
  run('set', 'viewport', '390', '430')
  check('rotation and keyboard height retain the selected column count', `window.__workspaceTerm.cols===80 && document.querySelector('#viewport').dataset.columns==='fixed'`)
  run('set', 'viewport', '390', '844')
  menu('sessions')
  run('select', '#terminal-columns', '0')
  close('session-dialog')
  check('automatic columns return to the phone width', `window.__workspaceTerm.cols<80 && document.querySelector('#viewport').dataset.columns==='fit'`)

  const output = '\r\n+added 中文\r\n-removed code\r\nhttps://example.com/docs\r\n<script>window.__unsafe=true</script>\r\n' + Array.from({ length: 45 }, (_, i) => 'line ' + i).join('\r\n')
  evaluate(`new Promise(resolve=>window.__workspaceTerm.write(${JSON.stringify(output)},resolve))`)
  menu('read')
  check('reader captures terminal output safely and colors diff lines', `document.querySelector('#reader-content').textContent.includes('+added 中文') && document.querySelector('#reader-content .diff-added') && !document.querySelector('#reader-content script') && !window.__unsafe`)
  run('fill', '#reader-query', '中文')
  check('literal Unicode output search highlights its match', `document.querySelector('#reader-content mark').textContent==='中文' && document.querySelector('#reader-status').textContent==='1 / 1'`)
  run('fill', '#reader-query', '')
  evaluate(`document.querySelector('#reader-scroll').scrollTop=200;window.__readerText=document.querySelector('#reader-content').textContent;window.__readerTop=document.querySelector('#reader-scroll').scrollTop;const id=[...window.__mobileFixture.state.sessions.keys()][0];window.__mobileFixture.pushScreen(id,'new live output')`)
  check('new terminal output cannot replace or scroll a frozen reader', `document.querySelector('#reader-refresh').textContent.includes('有新输出') && document.querySelector('#reader-content').textContent===window.__readerText && document.querySelector('#reader-scroll').scrollTop===window.__readerTop`)
  evaluate(`document.querySelector('#reader-scroll').scrollTop=0`)
  check('reader link is visible after scrolling back to it', `document.querySelector('#reader-content .reader-link').getBoundingClientRect().top>=document.querySelector('#reader-scroll').getBoundingClientRect().top`)
  run('click', '#reader-content .reader-link')
  check('web links open only after an explicit tap', `window.__mobileFixture.state.openedLinks[0]==='https://example.com/docs'`)
  run('set', 'viewport', '320', '640')
  check('reader and search controls fit a 320px phone', fits)
  capture('03-reader-320')
  run('set', 'viewport', '844', '230')
  check('search and read-only content stay usable above a landscape keyboard', `${fits} && document.querySelector('#reader-scroll').getBoundingClientRect().height>=40 && document.querySelector('#reader-query').getBoundingClientRect().bottom<=innerHeight`)
  capture('03-reader-landscape-keyboard')
  run('set', 'viewport', '320', '640')
  run('click', '#reader-refresh')
  check('explicit refresh updates the output snapshot', `document.querySelector('#reader-content').textContent.includes('new live output')`)
  close('reader-dialog')

  run('fill', '#compose', '重启后要恢复的本项目草稿')
  run('reload')
  check('phone reload retains local editing state', `typeof window.qingLink==='function' && localStorage.getItem('qingcode:mobile:workspace-state').includes('重启后要恢复')`)
  evaluate('window.__mobileFixture.state.nextSession=100')
  pair()
  menu('submissions')
  check('a new terminal can recover the old project draft after session loss', `document.querySelector('#submission-list').textContent.includes('本项目其他会话草稿')`)
  evaluate(`const rows=[...document.querySelectorAll('#submission-list button')];rows.find(row=>row.textContent.includes('重启后要恢复')).click()`)
  run('click', '#restore-submission')
  check('restoring a lost-session draft never creates an automatic input', `document.querySelector('#expanded-compose').value==='重启后要恢复的本项目草稿' && window.__mobileFixture.state.inputs.length===0`)
  run('set', 'viewport', '844', '230')
  check('expanded editing remains inside a landscape keyboard viewport', fits)
  capture('04-editor-landscape-keyboard')
  close('expanded-dialog')
  const errors = JSON.parse(run('errors', '--json'))
  if (errors.data?.errors?.length) throw new Error(JSON.stringify(errors.data.errors))
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure') } catch { /* Keep the original error. */ }
  try { writeFileSync(resolve(directory, 'browser-errors.json'), run('errors', '--json')) } catch { /* Preserve the test result. */ }
  try { writeFileSync(resolve(directory, 'failure-layout.json'), evaluate(`JSON.stringify(['reader-dialog','reader-scroll','reader-query','reader-content','expanded-dialog'].map(id=>{const el=document.getElementById(id),s=getComputedStyle(el),r=el.getBoundingClientRect();return {id,open:el.open,background:s.backgroundColor,opacity:s.opacity,height:r.height,top:r.top,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight}}))`)) } catch { /* Preserve the test result. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', nativeIntegration: false, results }, null, 2))
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  writeFileSync(resolve(directory, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机终端编辑与阅读验收</title><h1>手机终端编辑与阅读验收</h1><p>真实 Web 资产和 xterm，原生连接由内存 fixture 模拟；不包含真机键盘、后台和外部浏览器验收。</p><ul>${results.map(item => `<li>${item.passed ? '通过' : '失败'}：${escape(item.name)}</li>`).join('')}</ul>`)
  try { run('close') } catch { /* Browser may already be closed. */ }
}
console.log(`${results.filter(item => item.passed).length}/${results.length} browser checks passed. ${directory}`)
