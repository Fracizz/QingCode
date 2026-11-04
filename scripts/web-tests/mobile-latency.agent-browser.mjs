import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-latency-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-latency')
mkdirSync(directory, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding:'utf8', timeout:30000 })
const evaluate = expression => run('eval', expression)
const check = (name, expression) => { run('wait', '--fn', expression); results.push({ name, passed:true }) }
const capture = name => { run('wait', '300'); return run('screenshot', resolve(directory, `${name}.png`)) }
const value = `document.querySelector('#terminal-latency').textContent`
const refresh = () => evaluate('window.qingVisibility(false); window.qingVisibility(true)')
const closeDetails = () => {
  run('wait', '300')
  run('click', '#host-dialog [data-close]')
  run('wait', '--fn', `!document.querySelector('#host-dialog').open`)
}

try {
  run('set', 'viewport', '390', '844')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  evaluate('localStorage.clear(); location.reload()')
  check('fixture loads', `typeof window.qingLink==='function'`)
  evaluate(`window.qingLink(window.__mobileFixture.link('192.168.1.8',48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('home shows the current computer response latency', `document.querySelector('#active-host').dataset.state==='online' && document.querySelector('#home-latency').textContent.includes('32 ms')`)
  run('click', '#dashboard-nav [data-page="connection"]')
  run('click', '.connection-card .icon-button')
  check('connection details explain scope and show the measurement time', `document.querySelector('#host-latency').textContent.includes('32 ms') && document.querySelector('#host-latency').textContent.includes('最近测量') && document.querySelector('#host-latency').textContent.includes('不包含电脑到远端')`)
  capture('01-connection-details')
  closeDetails()
  evaluate('window.__beforeTerminalProbeCount=window.__mobileFixture.state.latencyRequests.length')
  run('click', '#dashboard-nav [data-page="project"]')
  run('click', '#project-list .row:first-child')
  check('terminal shares the existing sample without another request', `${value}==='电脑 32 ms' && window.__mobileFixture.state.latencyRequests.length===window.__beforeTerminalProbeCount && document.querySelector('#terminal-status').textContent==='会话中'`)
  evaluate('window.__mobileFixture.state.latency=78.6')
  check('visible terminal refreshes at the terminal sampling interval', `${value}==='电脑 79 ms' && window.__mobileFixture.state.latencyRequests.length>window.__beforeTerminalProbeCount`)
  check('idle output polling is not used as the latency value', `window.__mobileFixture.state.polls.length>2 && ${value}==='电脑 79 ms'`)
  capture('02-terminal')
  run('set', 'viewport', '320', '640')
  check('320px state row and input remain inside the viewport', `document.documentElement.scrollWidth<=innerWidth && document.querySelector('#terminal-latency').getBoundingClientRect().right<=innerWidth && document.querySelector('#compose-form').getBoundingClientRect().bottom<=innerHeight`)
  capture('03-narrow')
  run('set', 'viewport', '844', '390')
  check('landscape latency stays visible with folded controls', `${value}==='电脑 79 ms' && document.querySelector('#terminal-latency').getBoundingClientRect().height>0 && document.querySelector('#compose-form').getBoundingClientRect().right<=innerWidth`)
  capture('04-landscape')
  evaluate('window.qingVisibility(false); window.__pausedCount=window.__mobileFixture.state.latencyRequests.length')
  run('wait', '10600')
  check('Android background lifecycle pauses probes', `window.__mobileFixture.state.latencyRequests.length===window.__pausedCount`)
  evaluate('window.__mobileFixture.state.latency=12; window.qingVisibility(true)')
  check('returning to the foreground immediately probes', `${value}==='电脑 12 ms' && window.__mobileFixture.state.latencyRequests.length===window.__pausedCount+1`)
  evaluate(`window.__mobileFixture.state.latencyError='模拟检测超时'`)
  refresh()
  check('failed probe clears the number while the terminal remains usable', `${value}==='电脑 --' && document.querySelector('#terminal-status').textContent==='会话中' && document.querySelector('#active-host').dataset.state==='online' && !document.querySelector('#send').disabled`)
  run('fill', '#compose', 'echo latency')
  run('click', '#send')
  check('a failed probe cannot block terminal input', `window.__mobileFixture.state.inputs.includes('echo latency'+String.fromCharCode(13))`)
  evaluate('window.__mobileFixture.state.latencyError=null; window.__mobileFixture.state.latencySupported=false')
  refresh()
  check('old desktop compatibility shows unavailable', `${value}==='电脑 --' && document.querySelector('#host-latency').textContent.includes('不支持延迟检测')`)
  evaluate('window.__unsupportedCount=window.__mobileFixture.state.latencyRequests.length')
  run('wait', '10600')
  check('unsupported desktop is not probed repeatedly', `window.__mobileFixture.state.latencyRequests.length===window.__unsupportedCount`)
  run('click', '#back')
  run('click', '#dashboard-nav [data-page="connection"]')
  run('click', '.connection-card .icon-button')
  check('details explain that an old desktop needs updating', `document.querySelector('#host-latency').textContent.includes('更新电脑端 QingCode')`)
  capture('05-unsupported')
  closeDetails()
  evaluate(`window.__mobileFixture.state.latencySupported=true; window.__mobileFixture.state.latency=99; window.__mobileFixture.state.latencyDelay=700; window.qingLink(window.__mobileFixture.link('192.168.1.8',48764))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('re-pairing restarts an unsupported sampler', `document.querySelector('#home-latency').textContent.includes('99 ms')`)
  evaluate('window.qingVisibility(false); window.__mobileFixture.state.latency=222; window.qingVisibility(true)')
  evaluate(`window.__mobileFixture.state.latencyDelay=0; window.__mobileFixture.state.latency=7; window.qingLink(window.__mobileFixture.link('10.0.0.9',48764,'f'.repeat(64),'备用电脑'))`)
  run('fill', '#pair-code', 'A8z2D3')
  run('click', '#pair-submit')
  check('switching computers never displays a late result from the old computer', `document.querySelector('#active-host-name').textContent==='备用电脑' && document.querySelector('#home-latency').textContent.includes('7 ms')`)
  run('wait', '900')
  check('new computer latency remains after the old request finishes', `document.querySelector('#home-latency').textContent.includes('7 ms') && !document.querySelector('#home-latency').textContent.includes('222')`)
  const errors=JSON.parse(run('errors','--json'))
  if (errors.data?.errors?.length) throw new Error(JSON.stringify(errors.data.errors))
} catch (error) {
  results.push({ name:String(error), passed:false })
  try { capture('failure') } catch { /* Preserve the first failure. */ }
  process.exitCode=1
} finally {
  writeFileSync(resolve(directory,'results.json'),JSON.stringify({engine:'agent-browser',nativeIntegration:false,results},null,2))
  try { run('close') } catch { /* Browser may have exited. */ }
}
console.log(`${results.filter(result=>result.passed).length}/${results.length} browser checks passed. ${directory}`)
