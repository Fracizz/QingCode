// 安卓终端鼠标模式 Web 验收：右侧滑块加粗、长按滑块进入鼠标模式（轻震、胶囊、滑块常驻），
// 普通终端点按选词、全屏程序点按发鼠标点击（默认设置下不发）、返回键 / 胶囊 / 菜单切换。
// 使用内存桥与合成触摸 / 指针事件，不替代真机触摸手感验收。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-mouse-mode')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile mouse mode 20261105')
  const page = task.page('p1')
  const results = []
  const shots = []
  const shot = async name => {
    try { await page.screenshot({ path: resolve(output, name) }); shots.push(name) } catch (error) { shots.push(name + ' (skipped: ' + error.name + ')') }
  }
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const mouseActive = () => page.evaluate(() => !document.querySelector('.mouse-mode-pill').hidden)

  /** 配对并打开一个预置会话；data 为会话初始屏幕。 */
  async function open(data) {
    await page.goto(baseUrl + '/mobile-android/?lang=zh')
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:') && key !== 'qingcode:mobile:locale') localStorage.removeItem(key)
    })
    await page.reload()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => {
      window.Terminal = class extends window.Terminal { constructor(...args) { super(...args); window.__mouseTerm = this } }
      window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))
    })
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.evaluate(data => window.__mobileFixture.state.sessions.set('mobile-mouse', {
      id: 'mobile-mouse', number: 1, project: 'p-local', next: 1, exit: null, waiters: [], output: [], history: [],
      snapshot: { data, cols: 80, rows: 24 },
    }), data)
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list .row:first-child')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
  }

  /** 在元素中心按住 ms 毫秒（合成指针事件），模拟长按滑块。 */
  const hold = (selector, ms) => page.evaluate(async ([selector, ms]) => {
    const target = document.querySelector(selector)
    const rect = target.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
    target.dispatchEvent(new PointerEvent('pointerdown', init))
    await new Promise(done => setTimeout(done, ms))
    target.dispatchEvent(new PointerEvent('pointerup', init))
  }, [selector, ms])

  /** 在终端第 row 行第 col 列点按：触摸 + 指针 + 兼容鼠标事件，与手机浏览器顺序一致。 */
  const tap = (col, row) => page.evaluate(([col, row]) => {
    const term = window.__mouseTerm
    const screen = term.element.querySelector('.xterm-screen')
    const rect = screen.getBoundingClientRect()
    const x = rect.left + (col + .5) * rect.width / term.cols
    const y = rect.top + (row + .5) * rect.height / term.rows
    const touch = new Touch({ identifier: 3, target: screen, clientX: x, clientY: y })
    const pointer = { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }
    screen.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch], changedTouches: [touch] }))
    screen.dispatchEvent(new PointerEvent('pointerdown', pointer))
    screen.dispatchEvent(new PointerEvent('pointerup', pointer))
    screen.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch] }))
    for (const type of ['mousedown', 'mouseup', 'click']) screen.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mousedown' ? 1 : 0, clientX: x, clientY: y }))
  }, [col, row])

  try {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} alpha-beta gamma`).join('\r\n')
    await open(lines + '\r\nPS D:\\code\\qingcode> ')
    await step('the scrollback slider is thicker and easy to hit', async () => {
      await page.evaluate(() => window.__mouseTerm.scrollLines(-60))
      await page.waitForFunction(() => !document.querySelector('.touch-scrollbar').hidden)
      const size = await page.evaluate(() => {
        const bar = document.querySelector('.touch-scrollbar').getBoundingClientRect()
        const thumb = document.querySelector('.touch-scrollbar-thumb').getBoundingClientRect()
        return { bar: bar.width, thumb: thumb.width, height: thumb.height }
      })
      assert.ok(size.bar >= 44, `hit area ${size.bar}`)
      assert.ok(size.thumb >= 16, `thumb width ${size.thumb}`)
      assert.ok(size.height >= 64, `thumb height ${size.height}`)
    })
    await shot('thick-slider.png')
    await step('a quick press on the thumb does not enter mouse mode', async () => {
      await hold('.touch-scrollbar-thumb', 120)
      assert.equal(await mouseActive(), false)
    })
    await step('long-pressing the thumb enters mouse mode with haptics and a pinned slider', async () => {
      await hold('.touch-scrollbar-thumb', 650)
      await page.waitForFunction(() => !document.querySelector('.mouse-mode-pill').hidden)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.haptics), 1)
      assert.equal(await page.evaluate(() => document.querySelector('.touch-scrollbar').classList.contains('pinned')), true)
      assert.match(await page.evaluate(() => document.querySelector('#font-toast').textContent), /鼠标模式/)
      // 回到底部后滑块仍常驻，方便继续拖动。
      await page.evaluate(() => window.__mouseTerm.scrollToBottom())
      await page.waitForTimeout(1800)
      assert.equal(await page.evaluate(() => document.querySelector('.touch-scrollbar').hidden), false)
    })
    await step('tapping a word in a normal terminal selects it and shows the tap marker', async () => {
      await page.evaluate(() => window.__mouseTerm.scrollLines(-30))
      await tap(12, 3)
      await page.waitForFunction(() => window.__mouseTerm.hasSelection())
      const selected = await page.evaluate(() => window.__mouseTerm.getSelection())
      assert.match(selected, /^alpha-beta$/)
      assert.equal(await page.evaluate(() => document.querySelector('.mouse-mode-marker').hidden), false)
      await shot('normal-select.png')
    })
    await step('back closes the selection first, then exits mouse mode', async () => {
      assert.equal(await page.evaluate(() => window.qingBack()), true)
      assert.equal(await mouseActive(), true)
      assert.equal(await page.evaluate(() => window.qingBack()), true)
      assert.equal(await mouseActive(), false)
      assert.equal(await page.evaluate(() => document.querySelector('.touch-scrollbar').classList.contains('pinned')), false)
    })
    await step('the terminal menu toggles mouse mode and the pill exits it', async () => {
      await page.click('#terminal-menu', { label: 'open terminal menu' })
      await page.waitForSelector('#terminal-menu-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#menu-mouse').textContent), '鼠标模式')
      await page.click('#menu-mouse', { label: 'enter mouse mode from menu' })
      await page.waitForFunction(() => !document.querySelector('.mouse-mode-pill').hidden)
      await page.click('.mouse-mode-pill', { label: 'exit mouse mode' })
      assert.equal(await mouseActive(), false)
    })

    await open('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[HCodex READY\r\n  > option one\r\n    option two')
    await page.waitForFunction(() => window.__mouseTerm?.modes.mouseTrackingMode !== 'none')
    const clicks = () => page.evaluate(() => (window.__mobileFixture.state.inputs.join('').match(/\x1b\[<0;\d+;\d+M/g) || []).length)
    await step('without mouse mode, taps in a full-screen program are not sent as clicks (default setting)', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.inputs.length = 0 })
      await tap(6, 2)
      await page.waitForTimeout(300)
      assert.equal(await clicks(), 0)
    })
    await step('the program slider is thicker and long-press enters mouse mode', async () => {
      await page.waitForFunction(() => !document.querySelector('.terminal-jog').hidden)
      const width = await page.evaluate(() => document.querySelector('.terminal-jog-track').getBoundingClientRect().width)
      assert.ok(width >= 44, `jog width ${width}`)
      await page.evaluate(() => { window.__mobileFixture.state.inputs.length = 0 })
      await hold('.terminal-jog-track', 650)
      await page.waitForFunction(() => !document.querySelector('.mouse-mode-pill').hidden)
      // 长按期间不滚动程序。
      assert.equal(await page.evaluate(() => /\x1b\[<6[45];/.test(window.__mobileFixture.state.inputs.join(''))), false)
      assert.equal(await page.evaluate(() => document.querySelector('.terminal-jog').classList.contains('pinned')), true)
      await page.waitForTimeout(2800)
      assert.equal(await page.evaluate(() => document.querySelector('.terminal-jog').hidden), false)
    })
    await step('in mouse mode, taps in a full-screen program are sent as mouse clicks at the tapped cell', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.inputs.length = 0 })
      await tap(6, 2)
      await page.waitForFunction(() => /\x1b\[<0;7;3M/.test(window.__mobileFixture.state.inputs.join('')))
      assert.equal(await page.evaluate(() => window.__mouseTerm.hasSelection()), false)
      await shot('program-click.png')
    })
  } catch (error) {
    results.push({ name: 'failure', passed: false, error: String(error?.stack ?? error) })
    await shot('failure.png')
    throw error
  } finally {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, shots }, null, 2))
    console.log(JSON.stringify({ spaceId: task.spaceId, results, shots }, null, 2))
  }
}
