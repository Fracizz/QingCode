import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Real Android assets and xterm; network, permissions and storage failures use fixtures.
// Android IME, TLS, notifications, lifecycle and battery usage still need a physical device.
const session = `mobile-reliability-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-reliability-linux')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => { run('wait', '--fn', expression); results.push({ name, passed: true }) }
const capture = name => run('screenshot', resolve(directory, `${name}.png`))
const settled = id => run('wait', '--fn', `document.getElementById('${id}').open && !document.getElementById('${id}').getAnimations().some(a=>a.playState==='running')`)
const menu = action => {
  run('click', '#terminal-menu')
  settled('terminal-menu-dialog')
  run('click', '#menu-' + action)
}
const ready = `document.querySelector('#terminal-status').textContent==='会话中'`

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('APK web assets initialize', `typeof window.qingLink==='function'`)
  evaluate(`(async()=>{
    const {createWorkspaceState}=await import('/mobile-android/workspaceState.js');
    const state=createWorkspaceState({storage:localStorage});
    const host='192.168.1.8:48764', project=window.__mobileFixture.state.projects[0].id;
    state.context(host+'/old',''+project,'Project');
    state.drafts.set(host+'/old','最旧但尚未发送的需求');
    const pending=state.submit(host+'/old','结果未知的原文');
    state.settle(host+'/old',pending,'unknown');
    for(let i=0;i<30;i++){
      const key=host+'/draft-'+i;
      state.context(key,project,'Project');
      state.drafts.set(key,'保留的草稿 '+i);
    }
  })()`)
  run('reload')
  check('reloaded APK initializes with over 24 protected drafts', `typeof window.qingLink==='function'`)
  evaluate(`window.qingLink(window.__mobileFixture.link('192.168.1.8',48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('paired computer is online', `document.querySelector('#active-host').dataset.state==='online'`)
  run('click', '#dashboard-nav [data-page="project"]')
  run('click', '#project-list > :first-child .project-row:first-child .row')
  evaluate('window.__mobileFixture.startTerminalIfEmpty()')
  check('terminal is attached', ready)
  menu('submissions')
  check('the oldest draft and unknown submission remain recoverable in the actual UI', `document.querySelector('#submission-list').textContent.includes('最旧但尚未发送的需求') && document.querySelector('#submission-list').textContent.includes('结果未知的原文') && [...document.querySelectorAll('#submission-list button')].filter(b=>b.textContent.includes('本项目其他会话草稿')).length===31`)
  capture('01-protected-drafts')
  evaluate(`document.querySelector('#submissions-dialog').close()`)

  evaluate(`window.__save=Storage.prototype.setItem;window.__failSave=true;Storage.prototype.setItem=function(key,value){if(window.__failSave&&key==='qingcode:mobile:workspace-state')throw new Error('quota');return window.__save.call(this,key,value)}`)
  run('fill', '#compose', '存储失败时仍可编辑')
  check('failed persistence is visible and leaves the draft editable', `!document.querySelector('#submission-state').hidden && document.querySelector('#submission-status').textContent==='手机保存失败' && document.querySelector('#compose').value==='存储失败时仍可编辑'`)
  evaluate('window.__failSave=false')
  run('fill', '#compose', '恢复保存后保留的新草稿')
  check('a successful save clears the failure and persists the exact draft', `document.querySelector('#submission-state').hidden && localStorage.getItem('qingcode:mobile:workspace-state').includes('恢复保存后保留的新草稿') && document.querySelector('#expanded-save-status').dataset.error==='false'`)

  check('draft editing keys describe their local target', `document.querySelector('#special-keys [data-key="backspace"]').getAttribute('aria-label')==='删除手机草稿中的文字'`)
  run('click', '#keyboard')
  check('direct input gives immediate feedback and describes the terminal target', `document.querySelector('#compose-form').dataset.mode==='raw' && document.querySelector('#special-keys [data-key="backspace"]').getAttribute('aria-label')==='删除终端中的文字' && document.querySelector('#font-toast').textContent==='直发：按键立即发送到终端'`)
  run('click', '#keyboard')
  check('switching back preserves the unsent draft and explains when it is sent', `document.querySelector('#compose').value==='恢复保存后保留的新草稿' && document.querySelector('#font-toast').textContent==='草稿：在手机编辑，点发送后提交'`)

  evaluate(`window.__realRequest=window.QingCodeNative.request;window.__failure={error:'连接超时，请确认电脑在线并允许局域网访问。'};window.__failedPolls=0;window.QingCodeNative.request=(id,payload)=>{const request=JSON.parse(payload);if(request.op==='poll'&&window.__failure){window.__failedPolls++;setTimeout(()=>window.qingReply(id,{ok:false,...window.__failure}),10);return;}window.__realRequest(id,payload)}`)
  check('reconnecting retains the actual timeout cause and disables remote input', `document.querySelector('#terminal-status').textContent.includes('连接超时') && document.querySelector('#terminal-status').textContent.includes('正在自动重连') && document.querySelector('#send').disabled`)
  capture('02-reconnect-cause')
  evaluate(`window.__failure=null`)
  check('reconnection restores the existing session and keeps its draft', `${ready} && !document.querySelector('#send').disabled && document.querySelector('#compose').value==='恢复保存后保留的新草稿'`)
  evaluate(`window.__failure={error:'Windows 身份校验失败，请重新核对证书指纹。',code:'identity'}`)
  check('identity verification failure requests re-pairing instead of looping', `document.querySelector('#terminal-status').textContent==='电脑身份校验失败，请重新扫码或粘贴配对链接。' && !document.querySelector('#terminal-retry').hidden`)
  evaluate('window.__stoppedPolls=window.__failedPolls')
  run('wait', '1100')
  check('identity failure stops automatic retries and never resends input', `window.__failedPolls===window.__stoppedPolls && window.__mobileFixture.state.inputs.length===0`)
  evaluate('window.__failure=null')
  run('click', '#terminal-retry')
  check('explicit retry reattaches the same session after repair', `${ready} && window.__mobileFixture.state.sessions.size===1`)

  evaluate(`new Promise(resolve=>window.__mobileFixture.terminal().write('\x1b[?1049h\x1b[?1000h\x1b[?1006hgesture test',resolve))`)
  evaluate(`window.__wheels=[];window.__gestureTarget=window.__mobileFixture.terminal().element.querySelector('.xterm-screen');window.__gestureTarget.addEventListener('wheel',e=>window.__wheels.push({momentum:e.qingMomentum,delta:e.deltaY}));window.__touch=(type,points)=>{const target=window.__gestureTarget;const touches=points.map(([x,y],i)=>new Touch({identifier:i+1,target,clientX:x,clientY:y}));const event=new TouchEvent(type,{bubbles:true,cancelable:true,touches,changedTouches:touches});target.dispatchEvent(event);return event.defaultPrevented}`)
  evaluate(`(async()=>{window.__touch('touchstart',[[100,200]]);window.__touch('touchmove',[[100,140]]);await new Promise(requestAnimationFrame);window.__touch('touchend',[])})()`)
  run('wait', '350')
  check('interactive program scrolling sends wheel input only during the drag, without momentum', `window.__wheels.length>0 && window.__wheels.every(e=>!e.momentum)`)
  evaluate(`window.__wheels=[];window.__mobileFixture.state.inputs=[];window.__touch('touchstart',[[100,100],[200,100]]);window.__touch('touchmove',[[80,100],[230,100]]);window.__touch('touchend',[[80,100]]);window.__remainingBlocked=window.__touch('touchmove',[[80,50]]);window.__touch('touchend',[])`)
  check('pinch zoom saves the font and blocks the remaining finger without sending program input', `window.__remainingBlocked && localStorage.getItem('qingcode:mobile:font-size')==='20' && window.__wheels.length===0 && window.__mobileFixture.state.inputs.length===0`)
  evaluate(`new Promise(resolve=>window.__mobileFixture.terminal().write('\x1b[?1000l\x1b[?1006l\x1b[?1049l',resolve))`)

  run('set', 'viewport', '844', '230')
  run('click', '#terminal-menu')
  settled('terminal-menu-dialog')
  for (const id of ['menu-edit','menu-submissions','menu-files','menu-read','menu-mouse','manage-sessions']) {
    evaluate(`document.getElementById('${id}').scrollIntoView({block:'nearest'})`)
    check(`landscape keyboard: ${id} can be scrolled into an unobstructed tap target`, `(()=>{const b=document.getElementById('${id}'),r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return b===hit||b.contains(hit)})()`)
  }
  capture('03-landscape-menu')
  evaluate(`document.querySelector('#terminal-menu-dialog').close()`)
  run('set', 'viewport', '390', '844')

  evaluate(`window.__current=[...window.__mobileFixture.state.sessions.values()][0];window.__current.lastActiveAt=Date.now()-23*3600e3`)
  run('click', '#show-sessions')
  settled('session-drawer')
  check('near-expiry sessions show idle time without an expiry warning or confirmation', `document.querySelector('#session-options').textContent.includes('空闲 23 小时') && !document.querySelector('#session-options').textContent.includes('自动结束') && !document.querySelector('#confirm-dialog').open`)
  evaluate(`document.querySelector('#session-drawer').close();window.__mobileFixture.state.sessions.delete(window.__current.id)`)
  check('an automatically removed session stops cleanly and keeps its draft without a dialog', `document.querySelector('#terminal-status').textContent.includes('原会话已不存在') && document.querySelector('#compose').value==='恢复保存后保留的新草稿' && !document.querySelector('dialog[open]')`)

  for (const [width,height] of [[320,640],[844,230]]) {
    run('set', 'viewport', String(width), String(height))
    check(`${width}x${height}: input and error feedback stay within the viewport`, `document.documentElement.scrollWidth<=innerWidth && document.querySelector('#compose-form').getBoundingClientRect().right<=innerWidth+1 && document.querySelector('#compose-form').getBoundingClientRect().bottom<=innerHeight+1`)
    capture(`03-layout-${width}`)
  }
  assert.deepEqual(JSON.parse(run('errors', '--json')).data?.errors ?? [], [])
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure') } catch { /* Keep the original error. */ }
  try { writeFileSync(resolve(directory, 'browser-errors.json'), run('errors', '--json')) } catch { /* Preserve the test result. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine:'agent-browser', nativeIntegration:false, results }, null, 2))
  const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  writeFileSync(resolve(directory, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机可靠性验收</title><h1>手机可靠性验收</h1><p>真实 Web 资产与 xterm；RPC 和存储故障由内存 fixture 模拟。未验证 Android 真机输入法、TLS、通知、息屏及耗电。</p><ul>${results.map(item=>`<li>${item.passed?'通过':'失败'}：${escape(item.name)}</li>`).join('')}</ul>`)
  try { run('close') } catch { /* Browser may already be closed. */ }
}
console.log(`${results.filter(item=>item.passed).length}/${results.length} browser checks passed. ${directory}`)
