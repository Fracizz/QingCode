import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-history-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-history')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => {
  run('wait', '--fn', expression)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(directory, `${name}.png`))
const historyText = `document.querySelector('#history-content').textContent`
const historyOpen = `!document.querySelector('#terminal-history').hidden`
const openHistory = () => evaluate(`window.__historyTerm.scrollToTop(); window.__historyTerm.element.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-80}))`)
const openTouchHistory = () => evaluate(`new Promise(resolve => {
  const target=window.__historyTerm.element.querySelector('.xterm-screen');
  const first=new Touch({identifier:1,target,clientX:100,clientY:120});
  const last=new Touch({identifier:1,target,clientX:100,clientY:220});
  target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[first],changedTouches:[first]}));
  target.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[last],changedTouches:[last]}));
  target.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[],changedTouches:[last]}));
  requestAnimationFrame(()=>requestAnimationFrame(()=>{target.dispatchEvent(new TouchEvent('touchcancel',{bubbles:true,touches:[]}));resolve()}));
})`)

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('fixture loads', `typeof window.qingLink === 'function'`)
  evaluate(`window.Terminal = class extends window.Terminal { constructor(...args) { super(...args); window.__historyTerm = this; } }; window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('paired computer is online', `document.querySelector('#active-host').dataset.state === 'online'`)
  evaluate(`window.__resumed = {
    id:'mobile-resume', number:1, project:'p-local', next:1000, exit:null, waiters:[],
    output:Array.from({length:1000}, (_,i)=>btoa('slow old output '+i+String.fromCharCode(13,10))),
    history:Array.from({length:360}, (_,i)=>'history line '+i),
    snapshot:{data:String.fromCharCode(27)+'[2J'+String.fromCharCode(27)+'[HLATEST READY'+String.fromCharCode(13,10)+'$ ', cols:80, rows:24}
  }; window.__mobileFixture.state.sessions.set(window.__resumed.id, window.__resumed); window.__mobileFixture.state.nextSession=2`)
  run('click', '#dashboard-nav [data-page="project"]')
  run('click', '#project-list > :first-child .project-row:first-child .row')
  evaluate('window.__mobileFixture.startTerminalIfEmpty()')
  check('reattach displays the latest screen without replaying the old stream', `document.querySelector('#terminal-status').textContent === '会话中' && window.__mobileFixture.terminalText().includes('LATEST READY') && !window.__mobileFixture.terminalText().includes('slow old output')`)
  check('first poll requests a snapshot and follows its exact sequence', `window.__mobileFixture.state.polls[0].latest === true && window.__mobileFixture.state.polls.some(p=>p.from===1000 && !p.latest) && !window.__mobileFixture.state.polls.some(p=>p.from===0 && !p.latest)`)
  check('history is not downloaded before the user requests it', `window.__mobileFixture.state.historyRequests.length === 0 && !document.querySelector('#history-open') && document.querySelector('#terminal-history').hidden`)
  capture('01-latest-screen')

  evaluate(`window.__inputsBeforeHistory = window.__mobileFixture.state.inputs.length`)
  openHistory()
  check('first history page contains only the latest 120 older lines', String.raw`${historyOpen} && ${historyText}.startsWith('history line 240\n') && ${historyText}.includes('history line 359\n') && !${historyText}.includes('history line 239\n') && window.__mobileFixture.state.historyRequests.length===1`)
  check('history begins with the visible terminal rows preserved at the bottom', `${historyText}.includes('LATEST READY')`)
  capture('02-first-history-page')
  evaluate(`document.querySelector('#history-scroll').scrollTop=0`)
  check('scrolling toward the top loads the preceding page once', String.raw`${historyText}.startsWith('history line 120\n') && ${historyText}.split('history line 240\n').length===2 && window.__mobileFixture.state.historyRequests.length===2 && document.querySelector('#history-scroll').scrollTop>1000`)
  evaluate(`window.__historyTop=document.querySelector('#history-scroll').scrollTop; window.__resumed.output.push(btoa('LIVE WHILE READING'+String.fromCharCode(13,10))); window.__resumed.next++; for(const wake of window.__resumed.waiters.splice(0)) wake()`)
  check('new output continues behind history without moving the reading position', `window.__mobileFixture.terminalText().includes('LIVE WHILE READING') && ${historyOpen} && document.querySelector('#history-scroll').scrollTop===window.__historyTop && !${historyText}.includes('LIVE WHILE READING')`)
  evaluate(`window.__resumed.truncated=true; document.querySelector('#history-scroll').scrollTop=0`)
  check('oldest retained page explains cache eviction and stops pagination', String.raw`${historyText}.startsWith('history line 0\n') && document.querySelector('#history-more').hidden && document.querySelector('#history-status').textContent.includes('超出电脑端缓存')`)
  check('history browsing sends no terminal input', `window.__mobileFixture.state.inputs.length===window.__inputsBeforeHistory`)
  evaluate(`window.__historyTopLine=()=>{
    const bounds=document.querySelector('#history-scroll').getBoundingClientRect();
    const range=document.caretRangeFromPoint(bounds.left+18,bounds.top+20);
    if(!range || !document.querySelector('#history-content').contains(range.startContainer)) return null;
    const text=range.startContainer.textContent, offset=range.startOffset;
    const start=text.lastIndexOf(String.fromCharCode(10),offset-1)+1, end=text.indexOf(String.fromCharCode(10),offset);
    return text.slice(start,end<0?text.length:end);
  };document.querySelector('#history-scroll').scrollTop=600`)
  check('history reading has a visible text anchor', `window.__historyTopLine()?.startsWith('history line ')`)
  evaluate('window.__historyAnchor=window.__historyTopLine()')
  run('set', 'viewport', '844', '390')
  check('rotation keeps the same text at the top of the history viewport', `window.__mobileFixture.state.fullscreen && window.__historyTopLine()===window.__historyAnchor`)
  run('set', 'viewport', '390', '844')
  check('returning to portrait preserves the history anchor', `!window.__mobileFixture.state.fullscreen && window.__historyTopLine()===window.__historyAnchor`)
  evaluate(`const scroller=document.querySelector('#history-scroll'); scroller.scrollTop=scroller.scrollHeight; scroller.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:80}))`)
  check('scrolling forward to the bottom returns to live output without a button', `document.querySelector('#terminal-history').hidden && window.__mobileFixture.terminalText().includes('LIVE WHILE READING')`)
  openHistory()
  check('history can be entered again with a scroll gesture', historyOpen)
  evaluate('window.qingBack()')
  check('Android Back returns to the live screen before leaving the terminal', `document.querySelector('#terminal-history').hidden && !document.querySelector('#terminal-screen').hidden && window.__mobileFixture.terminalText().includes('LIVE WHILE READING')`)

  evaluate(`window.__historyTerm.scrollToTop(); window.__historyTerm.element.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-80}))`)
  check('scrolling beyond local scrollback opens server history on demand', `${historyOpen} && ${historyText}.includes('history line 359')`)
  run('click', '#scroll-bottom')
  openTouchHistory()
  check('a finger drag toward earlier output opens paged history', `${historyOpen} && ${historyText}.includes('history line 359')`)
  run('click', '#scroll-bottom')

  evaluate(`window.__mobileFixture.state.historyError='模拟历史加载失败'`)
  openHistory()
  check('history failure provides a retry without resetting the live screen', `document.querySelector('#history-more').textContent==='重试加载历史' && document.querySelector('#history-status').textContent==='模拟历史加载失败' && window.__mobileFixture.terminalText().includes('LIVE WHILE READING')`)
  evaluate(`window.__mobileFixture.state.historyError=null`)
  run('click', '#history-more')
  check('retry succeeds at the same cursor', String.raw`${historyText}.startsWith('history line 240\n') && !document.querySelector('#history-more').disabled`)
  run('click', '#scroll-bottom')

  evaluate(`window.__snapshotsBefore=window.__mobileFixture.state.polls.filter(p=>p.latest).length; window.__mobileFixture.state.pollErrors=1; for(const wake of window.__resumed.waiters.splice(0)) wake()`)
  check('a network interruption reattaches using a fresh snapshot', `window.__mobileFixture.state.polls.filter(p=>p.latest).length>window.__snapshotsBefore && document.querySelector('#terminal-status').textContent==='会话中' && !window.__mobileFixture.terminalText().includes('slow old output')`)

  evaluate(`new Promise(resolve=>window.__historyTerm.write(String.fromCharCode(27)+'[?1049h',resolve))`)
  evaluate(`window.__historyTerm.element.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-80}))`)
  check('full-screen programs retain their wheel behavior', `document.querySelector('#terminal-history').hidden && window.__historyTerm.buffer.active.type==='alternate'`)
  openTouchHistory()
  check('a touch drag opens retained history even from a TUI', `${historyOpen} && ${historyText}.includes('history line 359')`)
  run('click', '#scroll-bottom')
  evaluate(`new Promise(resolve=>window.__historyTerm.write(String.fromCharCode(27)+'[?1049l',resolve))`)

  run('set', 'viewport', '844', '390')
  check('landscape controls settle after rotation', `document.querySelector('#special-keys').hidden && document.querySelector('#terminal-screen').dataset.keysCollapsed==='true'`)
  evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  check('landscape automatically enters native fullscreen before opening history', `window.__mobileFixture.state.fullscreen && document.querySelector('#terminal-screen').dataset.fullscreen==='true'`)
  openHistory()
  check('read-only history fits landscape fullscreen', `${historyOpen} && document.querySelector('#terminal-history').getBoundingClientRect().bottom <= innerHeight && document.querySelector('#scroll-bottom').getBoundingClientRect().right <= innerWidth`)
  capture('03-landscape-history')
  evaluate('window.qingBack()')
  check('Back closes history while landscape remains immersive', `document.querySelector('#terminal-history').hidden && document.querySelector('#terminal-screen').dataset.fullscreen==='true'`)
  run('set', 'viewport', '390', '844')
  check('portrait restores normal mode after closing history', `!window.__mobileFixture.state.fullscreen && !document.querySelector('#terminal-screen').hidden`)

  evaluate(`window.__mobileFixture.state.historyDelay=800`)
  openHistory()
  check('delayed page is loading', `document.querySelector('#terminal-history').getAttribute('aria-busy')==='true'`)
  run('click', '#new-session')
  run('click', '#new-session-dialog [data-profile="default"]')
  evaluate('window.__switchedAt=performance.now()')
  check('late history cannot leak into a different session', `performance.now()-window.__switchedAt>950 && document.querySelector('#terminal-history').hidden && ${historyText}==='' && !window.__mobileFixture.terminalText().includes('history line')`)
  evaluate(`window.__motionSamples=[]; new Promise(resolve=>{
    const record=e=>{if(e.qingTouch) window.__motionSamples.push({delta:e.deltaY, coast:e.qingMomentum})};
    window.addEventListener('wheel',record,true);
    const target=window.__historyTerm.element.querySelector('.xterm-screen');
    const point=y=>new Touch({identifier:1,target,clientX:100,clientY:y});
    target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[point(200)]}));
    for(let y=199;y>=100;y--) target.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[point(y)]}));
    requestAnimationFrame(()=>{target.dispatchEvent(new TouchEvent('touchcancel',{bubbles:true,touches:[]}));window.removeEventListener('wheel',record,true);resolve()});
  })`)
  check('one hundred rapid touch moves become one frame with the full distance', `window.__motionSamples.length===1 && window.__motionSamples[0].delta===100 && !window.__motionSamples[0].coast`)
  const errors = JSON.parse(run('errors', '--json'))
  if (errors.data?.errors?.length) throw new Error(JSON.stringify(errors.data.errors))
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { writeFileSync(resolve(directory,'failure-state.json'), evaluate(`JSON.stringify({history:document.querySelector('#history-content')?.textContent.slice(0,160), requests:window.__mobileFixture?.state.historyRequests, status:document.querySelector('#history-status')?.textContent, panelHidden:document.querySelector('#terminal-history')?.hidden, fullscreen:window.__mobileFixture?.state.fullscreen, fullscreenRequests:window.__mobileFixture?.state.fullscreenRequests, dataset:document.querySelector('#terminal-screen')?.dataset, clicks:window.__clicks, errors:window.__errors})`)) } catch { /* Preserve the original failure. */ }
  try { capture('failure') } catch { /* Preserve the original failure. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine:'agent-browser', nativeIntegration:false, results }, null, 2))
  const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  writeFileSync(resolve(directory,'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>手机终端快速接回与历史验收</title><h1>手机终端快速接回与历史验收</h1><p>真实 Web/xterm 与内存 RPC，解析器及游标由 Rust 测试覆盖；不含真机远程链路验收。</p><ul>${results.map(r=>`<li>${r.passed?'通过':'失败'}：${escape(r.name)}</li>`).join('')}</ul></html>`)
  try { run('close') } catch { /* Browser may be closed. */ }
}
console.log(`${results.filter(r=>r.passed).length}/${results.length} browser checks passed. ${directory}`)
