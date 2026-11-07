import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-selection-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-selection')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => { run('wait', '--fn', expression); results.push({ name, passed: true }) }
const capture = name => run('screenshot', resolve(directory, `${name}.png`))
const selecting = `!document.querySelector('.terminal-selection-tools').hidden`
// 按文字查找按钮：「添加到对话」隐藏时仍在 DOM 中，按序号会点错。
const clickTool = text => evaluate(`[...document.querySelectorAll('.terminal-selection-tools button')].find(b => b.textContent === ${JSON.stringify(text)}).click()`)
const copiedToast = `!document.querySelector('#font-toast').hidden && document.querySelector('#font-toast').textContent==='已复制'`
const hold = (col = 2, row = 0) => evaluate(`new Promise(resolve => {
  const target = window.__selectionTerm.element.querySelector('.xterm-screen');
  const rect = target.getBoundingClientRect();
  const touch = new Touch({identifier:1, target, clientX:rect.left + (${col}+.5)*rect.width/window.__selectionTerm.cols, clientY:rect.top + (${row}+.5)*rect.height/window.__selectionTerm.rows});
  target.dispatchEvent(new TouchEvent('touchstart', {bubbles:true, touches:[touch]}));
  setTimeout(() => { target.dispatchEvent(new TouchEvent('touchend', {bubbles:true, cancelable:true, touches:[], changedTouches:[touch]})); resolve(); }, 550);
})`)
const write = text => evaluate(`new Promise(resolve => { window.__selectionTerm.reset(); window.__selectionTerm.write(${JSON.stringify(text)}, resolve); })`)

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('fixture loads', `typeof window.qingLink === 'function'`)
  evaluate(`window.Terminal = class extends window.Terminal { constructor(...args) { super(...args); window.__selectionTerm=this; } }; window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('paired computer is online', `document.querySelector('#active-host').dataset.state==='online'`)
  run('click', '#dashboard-nav [data-page="project"]')
  run('click', '#project-list .row:first-child')
  evaluate('window.__mobileFixture.startTerminalIfEmpty()')
  check('terminal is ready', `document.querySelector('#terminal-status').textContent==='会话中'`)
  write('alpha 中文内容 omega\r\nsecond line\r\nthird line')
  evaluate('window.__inputCount=window.__mobileFixture.state.inputs.length')
  hold(7)
  check('holding a wide CJK cell selects the complete word', `${selecting} && window.__selectionTerm.getSelection()==='中文内容'`)
  check('both selection handles are available', `[...document.querySelectorAll('.terminal-selection-handle')].every(h=>!h.hidden)`)
  run('click', '.terminal-selection-tools button:first-child')
  check('copy writes exact Unicode text and closes the selection with a toast', `window.__mobileFixture.state.clipboard==='中文内容' && !(${selecting}) && !window.__selectionTerm.hasSelection() && ${copiedToast}`)
  capture('01-long-press-copy')
  hold(7)
  const end = JSON.parse(run('eval', '--json', `(() => { const r=document.querySelector('[data-side="end"]').getBoundingClientRect(); const s=window.__selectionTerm.element.querySelector('.xterm-screen').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+15,cell:s.width/window.__selectionTerm.cols,line:s.height/window.__selectionTerm.rows}; })()`)).data.result
  run('mouse', 'move', String(Math.round(end.x)), String(Math.round(end.y)))
  run('mouse', 'down')
  run('mouse', 'move', String(Math.round(end.x + end.cell * 4)), String(Math.round(end.y + end.line)))
  run('mouse', 'up')
  check('dragging the endpoint selects across rows', `window.__selectionTerm.getSelection().startsWith('中文内容 omega') && window.__selectionTerm.getSelection().includes('second line')`)
  capture('02-multiline-handles')
  clickTool('全选')
  clickTool('复制')
  check('select all copies multiline output', `window.__mobileFixture.state.clipboard.includes('alpha 中文内容 omega') && window.__mobileFixture.state.clipboard.includes('third line')`)
  check('selection and handle dragging send no terminal input', `window.__mobileFixture.state.inputs.length===window.__inputCount`)
  hold()
  evaluate('window.qingBack()')
  check('Android Back dismisses selection before leaving the terminal', `!(${selecting}) && !document.querySelector('#terminal-screen').hidden && !window.__selectionTerm.hasSelection()`)

  write('copy retry')
  hold()
  evaluate(`window.__mobileFixture.state.copyError='模拟剪贴板不可用'`)
  clickTool('复制')
  check('clipboard failure preserves the selection for retry', `${selecting} && window.__selectionTerm.getSelection()==='copy' && document.querySelector('.terminal-selection-tools [role="status"]').textContent==='模拟剪贴板不可用'`)
  evaluate('window.__mobileFixture.state.copyError=null')
  clickTool('复制')
  check('retry copies the retained selection and then closes it', `window.__mobileFixture.state.clipboard==='copy' && !(${selecting})`)
  run('click', '#keyboard')
  hold()
  check('long press and copy preserve raw-keyboard focus without causing an IME resize', `${selecting} && document.activeElement===window.__selectionTerm.textarea && document.querySelector('#keyboard').getAttribute('aria-pressed')==='true'`)
  run('click', '.terminal-selection-tools button:first-child')
  check('touch toolbar copying keeps keyboard focus', `document.activeElement===window.__selectionTerm.textarea && window.__mobileFixture.state.clipboard==='copy'`)

  write('\x1b[?1049h\x1b[?1000h\x1b[?1006hClaude 中文输出\r\nselect safely')
  hold(9)
  clickTool('复制')
  check('a mouse-tracking TUI supports selection without sending mouse reports', `window.__selectionTerm.modes.mouseTrackingMode!=='none' && window.__mobileFixture.state.clipboard==='中文输出' && window.__mobileFixture.state.inputs.length===window.__inputCount`)
  capture('03-tui-copy')
  write('fresh session')
  hold()
  run('set', 'viewport', '844', '390')
  check('rotation clears the old cell coordinates', `!(${selecting}) && !window.__selectionTerm.hasSelection()`)
  hold()
  check('selection toolbar fits landscape', `${selecting} && document.querySelector('.terminal-selection-tools').getBoundingClientRect().right<=innerWidth`)
  capture('04-landscape')
  clickTool('取消')
  write(Array.from({length:100}, (_,i)=>'buffer row '+i).join('\r\n'))
  hold(2, 2)
  evaluate('window.__selectedBeforeDrag=window.__selectionTerm.getSelection(); window.__viewportBeforeDrag=window.__selectionTerm.buffer.active.viewportY')
  const start = JSON.parse(run('eval', '--json', `(() => { const r=document.querySelector('[data-side="start"]').getBoundingClientRect(); const s=window.__selectionTerm.element.querySelector('.xterm-screen').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+15), edge:Math.round(s.top+1)}; })()`)).data.result
  run('mouse', 'move', String(start.x), String(start.y))
  run('mouse', 'down')
  run('wait', '60')
  check('grabbing a handle keeps its original selection until the finger moves', `window.__selectionTerm.getSelection()===window.__selectedBeforeDrag`)
  run('mouse', 'move', String(start.x), String(start.edge))
  check('dragging a handle at the upper edge scrolls loaded buffer history', `window.__selectionTerm.buffer.active.viewportY<window.__viewportBeforeDrag`)
  run('mouse', 'up')
  check('handles stay inside the terminal touch area', `(() => { const r=window.__selectionTerm.element.querySelector('.xterm-screen').getBoundingClientRect(); return [...document.querySelectorAll('.terminal-selection-handle')].filter(h=>!h.hidden).every(h=>{const b=h.getBoundingClientRect(); return b.left>=r.left-1 && b.right<=r.right+1 && b.bottom<=r.bottom+1;}); })()`)
  run('set', 'viewport', '390', '844')
  check('portrait restores session controls after automatic immersion', `!window.__mobileFixture.state.fullscreen && getComputedStyle(document.querySelector('.terminal-head')).display !== 'none'`)
  write('session selection')
  hold()
  run('click', '#new-session')
  run('click', '#new-session-dialog [data-profile="default"]')
  check('switching sessions disposes selection and old handles', `document.querySelectorAll('.terminal-selection-tools').length===1 && !(${selecting}) && !window.__selectionTerm.hasSelection()`)
  evaluate(`const s=[...window.__mobileFixture.state.sessions.values()].at(-1); s.history=Array.from({length:160},(_,i)=>'可选择的历史 '+i); s.output.push(btoa('live history')); s.next++; for(const wake of s.waiters.splice(0)) wake()`)
  check('new history metadata arrives', `window.__mobileFixture.terminalText().includes('live history')`)
  evaluate(`window.__selectionTerm.scrollToTop(); window.__selectionTerm.element.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-80}))`)
  check('paged history is available for system text selection', `!document.querySelector('#terminal-history').hidden && document.querySelector('#history-content').textContent.includes('可选择的历史')`)
  evaluate(`const content=document.querySelector('#history-content'); const range=document.createRange(); range.selectNodeContents(content); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); const scroll=document.querySelector('#history-scroll'); scroll.scrollTop=scroll.scrollHeight; scroll.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:80}))`)
  check('selected history stays open at the bottom without dropping selected text', `!document.querySelector('#terminal-history').hidden && getSelection().toString().includes('可选择的历史')`)
  const errors = JSON.parse(run('errors', '--json'))
  if (errors.data?.errors?.length) throw new Error(JSON.stringify(errors.data.errors))
} catch (error) {
  results.push({ name: String(error), passed: false })
  try { capture('failure') } catch { /* Keep the original failure. */ }
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine:'agent-browser', nativeIntegration:false, results }, null, 2))
  try { run('close') } catch { /* Browser may have exited. */ }
}
console.log(`${results.filter(result=>result.passed).length}/${results.length} browser checks passed. ${directory}`)
