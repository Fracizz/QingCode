import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, finish = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-tui-history')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode TUI swipe history 20261104')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const swipe = direction => page.evaluate(async direction => {
    const target = window.__tuiTerm.element.querySelector('.xterm-screen')
    const rect = target.getBoundingClientRect()
    const y = rect.top + Math.min(rect.height / 2, 200)
    const point = offset => new Touch({ identifier: 1, target, clientX: rect.left + 50, clientY: y + offset * direction })
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [point(0)] }))
    for (const offset of [30, 60, 100]) {
      target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [point(offset)] }))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }))
    target.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: [] }))
  }, direction)
  const latest = async () => {
    await page.click('#scroll-bottom', { label: 'return to live terminal' })
    await page.waitForFunction(() => document.querySelector('#terminal-history').hidden)
  }
  let screenRevision = 0
  const screen = async data => {
    const marker = 'FRAME-' + ++screenRevision
    await page.evaluate(({ data, marker }) => window.__mobileFixture.pushScreen('mobile-tui', '\x1b[?1049l\x1b[?1003l\x1b[?1006l' + data + ' ' + marker), { data, marker })
    await page.waitForFunction(marker => window.__mobileFixture.terminalText().includes(marker), marker)
  }
  try {
    await page.goto('http://127.0.0.1:38439/mobile-android/', { timeout: 60000 })
    await page.snapshot()
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => {
      window.Terminal = class extends window.Terminal { constructor(...args) { super(...args); window.__tuiTerm = this } }
      window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))
    })
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.evaluate(() => window.__mobileFixture.state.sessions.set('mobile-tui', {
      id: 'mobile-tui', number: 1, project: 'p-local', next: 1, exit: null, waiters: [], output: [],
      history: Array.from({ length: 360 }, (_, i) => '已显示过的回答 ' + i),
      snapshot: { data: '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HCodex READY', cols: 80, rows: 24 },
    }))
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list > :first-child .project-row:first-child .row')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await page.evaluate(() => window.qingOrientation(false))
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert.equal(await page.evaluate(() => document.querySelector('#touch-mode input:checked').value), 'view')
    for (const [name, control, alternate, mouse] of [
      ['Codex', '\x1b[?1049h\x1b[?1003h\x1b[?1006h', true, true],
      ['OpenCode', '\x1b[?1049h', true, false],
      ['inline TUI', '\x1b[?1003h\x1b[?1006h', false, true],
    ]) {
      await screen(control + '\x1b[2J\x1b[H' + name + ' READY')
      await page.waitForFunction(({ alternate, mouse }) => (window.__tuiTerm.buffer.active.type === 'alternate') === alternate
        && (window.__tuiTerm.modes.mouseTrackingMode !== 'none') === mouse, { alternate, mouse })
      for (const direction of [-1, 1]) {
        await step(`${name}: continuous ${direction < 0 ? 'upward' : 'downward'} drag opens and stays in read-only history`, async () => {
          await swipe(direction)
          await page.waitForFunction(() => !document.querySelector('#terminal-history').hidden
            && document.querySelector('#history-content').textContent.includes('已显示过的回答 359'))
          assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), [])
          assert.equal(await page.evaluate(() => window.__mobileFixture.terminalText().includes('READY')), true)
        })
        if (name === 'Codex') await page.screenshot({ path: resolve(output, direction < 0 ? 'upward-history.png' : 'downward-history.png') })
        await latest()
      }
    }
    await step('Claude-style ordinary terminal keeps natural local scrollback and mouse wheel behavior', async () => {
      await screen('\x1b[2J\x1b[H' + Array.from({ length: 160 }, (_, i) => 'Claude line ' + i + '\r\n').join('') + 'READY')
      await page.waitForFunction(() => window.__tuiTerm.buffer.active.type === 'normal' && window.__tuiTerm.buffer.active.baseY > 20)
      await swipe(1)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-history').hidden), true)
      assert.ok(await page.evaluate(() => window.__tuiTerm.buffer.active.viewportY < window.__tuiTerm.buffer.active.baseY))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), [])
    })
    await screen('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[HOpenCode READY')
    await step('history failures offer retry without sending input to the program', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.historyError = '模拟历史读取失败' })
      await swipe(-1)
      await page.waitForFunction(() => document.querySelector('#history-more').textContent === '重试加载历史')
      await page.evaluate(() => { window.__mobileFixture.state.historyError = null })
      await page.click('#history-more')
      await page.waitForFunction(() => document.querySelector('#history-content').textContent.includes('已显示过的回答 359'))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.inputs), [])
      await latest()
    })
    await step('empty history explains the boundary and shows the current screen instead of swallowing swipes', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.sessions.get('mobile-tui').history = [] })
      await screen('\x1b[?1049h\x1b[2J\x1b[HNO OLDER OUTPUT READY')
      await swipe(-1)
      await page.waitForFunction(() => !document.querySelector('#terminal-history').hidden
        && document.querySelector('#history-status').textContent.includes('暂无更早'))
      assert.equal(await page.evaluate(() => document.querySelector('#history-more').hidden), true)
      assert.match(await page.evaluate(() => document.querySelector('#history-content').textContent), /NO OLDER OUTPUT/)
      await latest()
    })
    await step('explicit program mode still forwards terminal wheel input', async () => {
      await page.evaluate(() => {
        const choice = document.querySelector('#touch-mode input[value="program"]')
        choice.checked = true; choice.dispatchEvent(new Event('change', { bubbles: true }))
      })
      for (const direction of [-1, 1]) {
        const before = await page.evaluate(() => window.__mobileFixture.state.inputs.length)
        await swipe(direction)
        await page.waitForFunction(before => window.__mobileFixture.state.inputs.length > before, before)
        assert.equal(await page.evaluate(() => document.querySelector('#terminal-history').hidden), true)
      }
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    throw error
  }
}
