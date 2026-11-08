import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 安卓终端打磨验收：输入模式标识与首次说明、已接收回执不常驻、输入框拖动移光标、
// 快捷键栏排序 / 隐藏、双指缩放字号，以及 320px / 键盘高度 / 横屏布局。
// 真实 Web 资产 + 内存桥；触摸经 CDP Input.dispatchTouchEvent 发出，不替代 Android 真机手感验收。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-terminal-polish')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode Android terminal polish 20261104')
  const page = task.page('p1')
  const results = []
  const screenshots = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const metrics = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
  // 无交互桌面时 Ego 截图会超时；截图失败只记录，不影响功能断言。
  const capture = async name => {
    try {
      await Promise.race([
        page.screenshot({ path: resolve(output, name + '.png') }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 15000)),
      ])
      screenshots.push({ name, saved: true })
    } catch (error) {
      screenshots.push({ name, saved: false, error: String(error.message ?? error) })
    }
  }
  const settled = selector => page.waitForFunction(target => {
    const element = document.querySelector(target)
    return element && !element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
  }, selector)
  const touch = (type, points) => page.cdp('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y], index) => ({ x, y, id: index + 1, radiusX: 2, radiusY: 2, force: 1 })),
  })
  const center = selector => page.evaluate(target => {
    const box = document.querySelector(target).getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, selector)
  const resetInputs = () => page.evaluate(() => { window.__mobileFixture.state.inputs = []; window.__mobileFixture.state.inputEvents = [] })
  const inputs = () => page.evaluate(() => window.__mobileFixture.state.inputs.join(''))
  const text = selector => page.evaluate(target => document.querySelector(target)?.textContent ?? '', selector)
  const barKeys = () => page.evaluate(() => [...document.querySelectorAll('#special-keys > [data-key]')].map(item => item.dataset.key))
  const openKeyLayout = async () => {
    await page.click('#terminal-menu', { label: 'open terminal menu' })
    await page.waitForSelector('#terminal-menu-dialog[open]')
    await page.click('#manage-sessions', { label: 'open terminal settings' })
    await page.waitForSelector('#session-dialog[open]')
    await settled('#session-dialog')
    await page.click('#open-key-layout', { label: 'open shortcut bar layout' })
    await page.waitForSelector('#key-layout-dialog[open]')
    await settled('#key-layout-dialog')
  }
  const closeDialogs = async () => {
    await page.evaluate(() => { while (document.querySelector('dialog[open]')) window.qingBack() })
  }
  const waitTerminal = () => page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
  // 内存桥在页面重新加载后清空，需重新配对并打开项目；手机 localStorage 中的偏好保留。
  const connect = async () => {
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'browse fixture projects' })
    await page.click('#project-list > :first-child .project-row:first-child .row', { label: 'open terminal project' })
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await waitTerminal()
  }
  try {
    await metrics(390, 844)
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.goto(baseUrl + '/mobile-android/')
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
    await page.reload()
    await metrics(390, 844)
    await connect()

    await step('the status line names the input target and a one-time tip explains draft and direct input', async () => {
      assert.match(await page.evaluate(() => document.querySelector('#compose').placeholder), /草稿/)
      assert.equal(await page.evaluate(() => document.querySelector('#compose-form').dataset.mode), 'compose')
      assert.ok(await page.evaluate(() => !document.querySelector('#input-tip').hidden && document.querySelector('#input-tip').getBoundingClientRect().height > 0))
      assert.match(await page.evaluate(() => document.querySelector('#compose').placeholder), /草稿/)
      await capture('01-first-entry-tip')
      await page.click('#keyboard', { label: 'switch to direct input' })
      await page.waitForFunction(() => document.querySelector('#compose-form').dataset.mode === 'raw')
      assert.equal(await page.evaluate(() => document.querySelector('#compose-form').dataset.mode), 'raw')
      assert.equal(await page.evaluate(() => document.querySelector('#input-tip').hidden), true)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:input-tip-seen')), 'true')
      await capture('02-direct-input')
      await page.click('#keyboard', { label: 'switch back to draft input' })
      await page.waitForFunction(() => document.querySelector('#compose-form').dataset.mode === 'compose')
      // 离开再进入终端后不再显示说明。
      await page.evaluate(() => window.qingBack())
      await page.click('#project-list > :first-child .project-row:first-child .row', { label: 'reopen terminal project' })
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await waitTerminal()
      assert.equal(await page.evaluate(() => document.querySelector('#input-tip').hidden), true)
    })

    await step('a received receipt shows briefly, then the input box carries no lingering check mark', async () => {
      await page.fill('#compose', 'echo clean')
      await page.click('#send', { label: 'submit draft' })
      await page.waitForFunction(() => document.querySelector('#submission-status').textContent.includes('电脑已接收')
        && !document.querySelector('#submission-state').hidden)
      await page.waitForFunction(() => document.querySelector('#submission-state').hidden
        && getComputedStyle(document.querySelector('.compose-notes')).display === 'none', undefined, { timeout: 8000 })
      const clean = await page.evaluate(() => ({
        visibleText: [...document.querySelectorAll('#compose-form *')].filter(item => item.getClientRects().length && !item.children.length)
          .map(item => item.textContent.trim()).filter(Boolean),
        height: document.querySelector('#compose-form').getBoundingClientRect().height,
      }))
      assert.ok(!clean.visibleText.some(value => value.includes('✓')), JSON.stringify(clean))
      assert.ok(clean.height <= 58, JSON.stringify(clean))
      await capture('03-input-clean-after-receipt')
    })

    await step('dragging across the draft moves its caret; in direct input it sends arrow keys', async () => {
      await page.fill('#compose', 'abcdefghij')
      await page.evaluate(() => { const compose = document.querySelector('#compose'); compose.focus(); compose.setSelectionRange(10, 10) })
      await resetInputs()
      const { x, y } = await center('#compose')
      // 浏览器在约 15px 的触摸阈值内不派发 touchmove，首次移动取 30px 作为明确的接管点。
      await touch('touchStart', [[x + 30, y]])
      await touch('touchMove', [[x, y]])
      await touch('touchMove', [[x - 30, y]])
      assert.equal(await page.evaluate(() => document.querySelector('#compose-form').dataset.dragging), 'true')
      await capture('04-cursor-drag')
      await touch('touchMove', [[x - 60, y]])
      await touch('touchEnd', [])
      const draft = await page.evaluate(() => ({ value: document.querySelector('#compose').value, caret: document.querySelector('#compose').selectionStart,
        dragging: document.querySelector('#compose-form').dataset.dragging ?? null }))
      assert.deepEqual(draft, { value: 'abcdefghij', caret: 4, dragging: null })
      assert.equal(await inputs(), '')

      await page.click('#keyboard', { label: 'switch to direct input' })
      await page.waitForFunction(() => document.querySelector('#compose-form').dataset.mode === 'raw')
      await resetInputs()
      await touch('touchStart', [[x - 60, y]])
      await touch('touchMove', [[x - 30, y]])
      await touch('touchMove', [[x - 2, y]])
      await touch('touchMove', [[x + 26, y]])
      await touch('touchEnd', [])
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.join('').length >= 12)
      assert.equal(await inputs(), '\x1b[C'.repeat(4))
      // 拖动不会把编辑目标切回草稿，也不会改动保留的草稿。
      assert.equal(await page.evaluate(() => document.querySelector('#compose-form').dataset.mode), 'raw')
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), 'abcdefghij')
      await page.click('#keyboard', { label: 'switch back to draft input' })
      await page.fill('#compose', '')
    })

    await step('the shortcut bar can be reordered and keys hidden into More, and the layout persists', async () => {
      await openKeyLayout()
      await capture('05-key-layout-editor')
      for (let index = 0; index < 7; index += 1) await page.click('[data-layout-key="slash"] [data-role="up"]', { label: 'move slash key up' })
      await page.click('[data-layout-key="shift-tab"] [data-role="toggle"]', { label: 'hide Shift+Tab' })
      const keys = await barKeys()
      assert.equal(keys[0], 'slash')
      assert.ok(!keys.includes('shift-tab'), keys.join())
      assert.equal(await page.evaluate(() => document.querySelector('#special-keys').lastElementChild.id), 'more-keys')
      assert.equal(await page.evaluate(() => document.querySelector('[data-layout-key="slash"] [data-role="up"]').disabled), true)
      await closeDialogs()
      await page.click('#more-keys', { label: 'open more keys' })
      await page.waitForSelector('#keys-dialog[open]')
      await settled('#keys-dialog')
      assert.equal(await page.evaluate(() => document.querySelector('#overflow-keys-section').hidden), false)
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#overflow-keys [data-key]')].map(item => item.dataset.key)), ['shift-tab'])
      await capture('06-more-with-hidden-key')
      await resetInputs()
      await page.click('#overflow-keys [data-key="shift-tab"]', { label: 'send hidden Shift+Tab from More' })
      await page.waitForFunction(() => window.__mobileFixture.state.inputs.join('').includes('\x1b[Z'))
      assert.equal(await page.evaluate(() => document.querySelector('#keys-dialog').open), false)

      await page.reload()
      await metrics(390, 844)
      await connect()
      // 重新进入终端不回放以前已接收的回执，输入框保持干净。
      assert.equal(await page.evaluate(() => document.querySelector('#submission-state').hidden), true)
      const restored = await barKeys()
      assert.equal(restored[0], 'slash')
      assert.ok(!restored.includes('shift-tab'))
      await openKeyLayout()
      await page.click('#key-layout-reset', { label: 'restore default shortcut layout' })
      assert.deepEqual(await barKeys(), ['esc', 'tab', 'interrupt', 'shift-tab', 'up', 'down', 'backspace', 'slash', 'left', 'right'])
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:key-layout')), null)
      assert.equal(await page.evaluate(() => document.querySelector('#key-layout-reset').disabled), true)

      // 长按一行拖到顶部：松手后排到第一位，且不会误触该行的开关。
      const pause = ms => new Promise(done => setTimeout(done, ms))
      const from = await center('[data-layout-key="right"] .key-name')
      const top = await center('[data-layout-key="esc"] .key-name')
      await touch('touchStart', [[from.x, from.y]])
      await pause(450)
      assert.equal(await page.evaluate(() => document.querySelector('[data-layout-key="right"]').classList.contains('dragging')), true)
      for (let index = 1; index <= 8; index += 1) await touch('touchMove', [[from.x, from.y + (top.y - from.y) * index / 8]])
      await capture('06b-key-layout-dragging')
      await touch('touchEnd', [])
      await page.waitForFunction(() => document.querySelector('#key-layout-list .key-layout-row')?.dataset.layoutKey === 'right')
      assert.equal((await barKeys())[0], 'right')
      assert.equal(await page.evaluate(() => document.querySelector('[data-layout-key="right"] [data-role="toggle"]').checked), true)
      // 按住前就滑动视为滚动，不进入拖动、不改顺序。
      const quick = await center('[data-layout-key="left"] .key-name')
      await touch('touchStart', [[quick.x, quick.y]])
      await touch('touchMove', [[quick.x, quick.y - 40]])
      await pause(450)
      await touch('touchEnd', [])
      assert.equal(await page.evaluate(() => Boolean(document.querySelector('#key-layout-list[data-dragging], .key-layout-row.dragging'))), false)
      assert.equal((await barKeys())[0], 'right')
      await page.click('#key-layout-reset', { label: 'restore default shortcut layout after drag' })
      await closeDialogs()
    })

    await step('pinching the terminal resizes the font with a live label and sends nothing to the program', async () => {
      await resetInputs()
      assert.equal(await page.evaluate(() => window.__mobileFixture.terminalFontSize()), 13)
      const before = await page.evaluate(() => window.__mobileFixture.terminalSize())
      const { x, y } = await center('#viewport')
      await touch('touchStart', [[x - 50, y], [x + 50, y]])
      await touch('touchMove', [[x - 62, y], [x + 62, y]])
      await touch('touchMove', [[x - 75, y], [x + 75, y]])
      await page.waitForFunction(() => window.__mobileFixture.terminalFontSize() === 20)
      assert.equal(await page.evaluate(() => !document.querySelector('#font-toast').hidden && document.querySelector('#font-toast').textContent), '字号 20px')
      await capture('07-pinch-font-label')
      await touch('touchEnd', [])
      await page.waitForFunction(() => localStorage.getItem('qingcode:mobile:font-size') === '20')
      assert.equal(await text('#font-size'), '20px')
      await page.waitForFunction(rows => window.__mobileFixture.terminalSize().rows < rows, before.rows)
      await page.waitForFunction(() => document.querySelector('#font-toast').hidden, undefined, { timeout: 3000 })
      await touch('touchStart', [[x - 100, y], [x + 100, y]])
      await touch('touchMove', [[x - 65, y], [x + 65, y]])
      await touch('touchEnd', [])
      await page.waitForFunction(() => localStorage.getItem('qingcode:mobile:font-size') === '13')
      await page.waitForFunction(() => document.querySelector('#font-toast').hidden, undefined, { timeout: 3000 })
      assert.equal(await inputs(), '')
    })

    await step('tapping a link in the live terminal opens a sheet; localhost becomes the computer address', async () => {
      await page.fill('#compose', 'echo http://localhost:5173/ and https://github.com/qingcode/pull/7')
      await page.click('#send', { label: 'print links in terminal' })
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('github.com/qingcode/pull/7'))
      // 找到终端缓冲中链接所在单元格的屏幕坐标，用真实触摸点按。
      const cellPoint = needle => page.evaluate(target => {
        const term = window.__mobileTerm
        const buffer = term.buffer.active
        for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y += 1) {
          const text = buffer.getLine(y)?.translateToString(true) ?? ''
          const x = text.indexOf(target)
          if (x < 0) continue
          const box = term.element.querySelector('.xterm-screen').getBoundingClientRect()
          const width = box.width / term.cols
          const height = box.height / term.rows
          return { x: box.left + (x + 3) * width + width / 2, y: box.top + (y - buffer.viewportY) * height + height / 2 }
        }
        return null
      }, needle)
      const tap = async point => {
        await touch('touchStart', [[point.x, point.y]])
        await touch('touchEnd', [])
      }
      await page.evaluate(() => { window.__mobileTerm = window.__mobileFixture.terminal() })
      const local = await cellPoint('http://localhost')
      assert.ok(local, 'link printed on screen')
      await tap(local)
      await page.waitForSelector('#link-dialog[open]')
      await settled('#link-dialog')
      assert.equal(await text('#link-url'), 'http://192.168.1.8:5173/')
      assert.equal(await text('#link-original'), '终端中为 http://localhost:5173/')
      assert.match(await text('#link-note'), /局域网/)
      await capture('12-terminal-link-sheet')
      await page.click('#link-copy', { label: 'copy terminal link' })
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.clipboard), 'http://192.168.1.8:5173/')
      await page.click('#link-open', { label: 'open terminal link' })
      await page.waitForFunction(() => !document.querySelector('#link-dialog').open)
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.openedLinks), ['http://192.168.1.8:5173/'])
      const pr = await cellPoint('https://github.com')
      await tap(pr)
      await page.waitForSelector('#link-dialog[open]')
      assert.equal(await text('#link-url'), 'https://github.com/qingcode/pull/7')
      assert.equal(await page.evaluate(() => document.querySelector('#link-original').hidden), true)
      await closeDialogs()
      // 点空白处只聚焦终端，不弹链接菜单。
      const blank = await page.evaluate(() => {
        const box = document.querySelector('#viewport').getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.bottom - 30 }
      })
      await tap(blank)
      await page.waitForTimeout(300)
      assert.equal(await page.evaluate(() => document.querySelector('#link-dialog').open), false)
      assert.ok(!(await inputs()).includes('[<'), 'no mouse report sent')

      // 全屏程序开启鼠标上报且触摸为「只查看」时，鼠标事件被拦截，链接按触点坐标识别，不向程序发点击。
      const sessionId = await page.evaluate(() => [...window.__mobileFixture.state.sessions.keys()].at(-1))
      await page.evaluate(id => window.__mobileFixture.pushScreen(id, '[?1049h[?1000h[2J[HTUI docs https://example.com/tui', 80, 24), sessionId)
      await page.waitForFunction(() => window.__mobileFixture.terminal().modes.mouseTrackingMode !== 'none'
        && window.__mobileFixture.terminalText().includes('example.com/tui'))
      await resetInputs()
      await tap(await cellPoint('https://example.com/tui'))
      await page.waitForSelector('#link-dialog[open]')
      assert.equal(await text('#link-url'), 'https://example.com/tui')
      const sent = await inputs()
      assert.ok(!sent.includes('[M') && !sent.includes('[<'), JSON.stringify(sent))
      await closeDialogs()
      await page.evaluate(id => window.__mobileFixture.pushScreen(id, 'PS D:\code\qingcode> ', 80, 24), sessionId)
      await page.waitForFunction(() => window.__mobileFixture.terminal().modes.mouseTrackingMode === 'none')
    })

    await step('the terminal fits at 390px, 320px, keyboard height and landscape', async () => {
      for (const [width, height, name] of [[390, 844, '08-portrait'], [320, 640, '09-narrow-320'], [390, 460, '10-keyboard-height'], [844, 390, '11-landscape']]) {
        await metrics(width, height)
        await page.evaluate(value => window.qingOrientation(value), width > 600)
        await page.waitForTimeout(250)
        const layout = await page.evaluate(() => {
          const form = document.querySelector('#compose-form').getBoundingClientRect()
          const latency = document.querySelector('#terminal-latency').getBoundingClientRect()
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            formInside: form.bottom <= innerHeight + 0.5 && form.left >= 0 && form.right <= innerWidth + 0.5,
            latencyVisible: latency.width > 0 && latency.right <= innerWidth,
          }
        })
        assert.deepEqual(layout, { overflow: false, formInside: true, latencyVisible: true }, name)
        await capture(name)
      }
      await metrics(390, 844)
      await page.evaluate(() => window.qingOrientation(false))
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots, nativeAndroid: false }, null, 2))
    console.log({ output, results, screenshots })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots, error: String(error?.stack ?? error), spaceId: task.spaceId }, null, 2))
    console.log({ output, spaceId: task.spaceId, results })
    throw error
  }
}
