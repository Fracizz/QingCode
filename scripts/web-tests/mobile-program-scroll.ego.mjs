import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 全屏程序（Codex / opencode）开启鼠标上报时：手指滑动按格发送滚轮、右侧回弹变速滑块与翻页按钮。
export async function run({ spaceId, finish = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-program-scroll')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode program wheel jog 20261105')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  // SGR 滚轮：64 = 向上，65 = 向下。
  const wheels = () => page.evaluate(() => {
    const text = window.__mobileFixture.state.inputs.join('')
    return { up: (text.match(/\x1b\[<64;/g) || []).length, down: (text.match(/\x1b\[<65;/g) || []).length }
  })
  const clearInputs = () => page.evaluate(() => { window.__mobileFixture.state.inputs.length = 0 })
  const swipe = (distance) => page.evaluate(async distance => {
    const target = window.__tuiTerm.element.querySelector('.xterm-screen')
    const rect = target.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    const point = offset => new Touch({ identifier: 1, target, clientX: rect.left + 50, clientY: y + offset })
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [point(0)] }))
    for (let step = 1; step <= 10; step += 1) {
      target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [point(distance * step / 10)] }))
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    // 停顿后抬手，不触发惯性，便于计数。
    await new Promise(resolve => setTimeout(resolve, 150))
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }))
  }, distance)
  try {
    await page.goto('http://127.0.0.1:38439/mobile-android/', { timeout: 60000 })
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
      history: Array.from({ length: 50 }, (_, i) => '已显示过的回答 ' + i),
      snapshot: { data: '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[HCodex READY', cols: 80, rows: 24 },
    }))
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list > :first-child .project-row:first-child .row')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await page.waitForFunction(() => window.__tuiTerm?.modes.mouseTrackingMode !== 'none')

    await step('jog slider appears when a program enables mouse reporting', async () => {
      await page.waitForFunction(() => document.querySelector('.terminal-jog') && !document.querySelector('.terminal-jog').hidden)
    })

    await step('a 10-row downward finger swipe sends several whole wheel-up ticks', async () => {
      await clearInputs()
      const cell = await page.evaluate(() => window.__tuiTerm.element.querySelector('.xterm-screen').getBoundingClientRect().height / window.__tuiTerm.rows)
      await swipe(cell * 10)
      await page.waitForTimeout(300)
      const count = await wheels()
      console.log('swipe 10 rows', count)
      // 慢滑每两行一格：约 5 格；旧实现只有 1–3 格。
      assert.ok(count.up >= 4, `expected >= 4 wheel-up ticks, got ${count.up}`)
      assert.equal(count.down, 0)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-history').hidden), true)
    })

    await step('holding the jog knob near the top scrolls continuously and stops on release', async () => {
      await clearInputs()
      const rect = await page.evaluate(() => {
        const r = document.querySelector('.terminal-jog-knob').getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
      await page.evaluate(async ({ x, y }) => {
        const track = document.querySelector('.terminal-jog-track')
        const fire = (type, clientY) => track.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY }))
        fire('pointerdown', y)
        fire('pointermove', y - 400)
        window.__jogHeld = document.querySelector('.terminal-jog').classList.contains('dragging')
        await new Promise(resolve => setTimeout(resolve, 1000))
        fire('pointerup', y - 400)
      }, rect)
      // 输入按 22ms 合批发送，等松手前的最后一批落地再计数。
      await page.waitForTimeout(150)
      const held = await wheels()
      console.log('jog 1s at full speed', held)
      await page.screenshot({ path: resolve(output, 'jog.png') }).catch(() => {})
      assert.ok(held.up >= 20 && held.up <= 45, `expected ~36 ticks/s, got ${held.up}`)
      assert.equal(held.down, 0)
      await page.waitForTimeout(400)
      assert.deepEqual(await wheels(), held, 'no more ticks after release')
      assert.equal(await page.evaluate(() => document.querySelector('.terminal-jog-knob').style.transform), '')
    })

    await step('page arrows send a third of the screen in wheel ticks', async () => {
      await clearInputs()
      await page.click('.terminal-jog-page[data-direction="down"]', { label: 'page down arrow' })
      await page.waitForTimeout(200)
      const rows = await page.evaluate(() => window.__tuiTerm.rows)
      const count = await wheels()
      console.log('page down', count, 'rows', rows)
      assert.equal(count.down, Math.max(3, Math.round(rows / 3)))
    })

    await step('soft keyboard keeps PTY rows and lifts the cursor row into view', async () => {
      const metrics = height => page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height, deviceScaleFactor: 1, mobile: true })
      await metrics(844)
      await page.waitForTimeout(400)
      const full = await page.evaluate(() => ({ rows: window.__tuiTerm.rows, resizes: window.__mobileFixture.state.resizes.length }))
      // 输入框在底部：光标移到最后一行。
      await page.evaluate(() => window.__mobileFixture.pushScreen('mobile-tui', '[999;1H> BOTTOM-INPUT'))
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('BOTTOM-INPUT'))
            // 模拟软键盘弹出：高度少 340px。
      await metrics(504)
      await page.waitForTimeout(500)
      const open = await page.evaluate(since => {
        const term = window.__tuiTerm
        const viewport = document.getElementById('viewport').getBoundingClientRect()
        const cell = term.element.querySelector('.xterm-screen').getBoundingClientRect().height / term.rows
        const cursorTop = term.element.querySelector('.xterm-screen').getBoundingClientRect().top + term.buffer.active.cursorY * cell
        return { rows: term.rows, marginTop: term.element.style.marginTop, cursorVisible: cursorTop >= viewport.top - 1 && cursorTop + cell <= viewport.bottom + 1, resizes: window.__mobileFixture.state.resizes.slice(since) }
      }, full.resizes)
      console.log('keyboard', { full, open })
      assert.equal(open.rows, full.rows, 'rows unchanged while the keyboard is open')
      assert.ok(open.cursorVisible, 'cursor row stays visible')
      assert.match(open.marginTop, /^-\d/, 'screen shifted up to the cursor row')
      assert.ok(open.resizes.every(item => item.rows === full.rows), 'no PTY row shrink sent')
      await metrics(844)
      await page.waitForTimeout(500)
      assert.equal(await page.evaluate(() => window.__tuiTerm.element.style.marginTop), '')
      await page.screenshot({ path: resolve(output, 'keyboard-closed.png') }).catch(() => {})
    })

    await step('jog hides when the program turns mouse reporting off', async () => {
      await page.evaluate(() => window.__mobileFixture.pushScreen('mobile-tui', '\x1b[?1000l\x1b[?1049l\x1b[2J\x1b[Hplain shell OFF'))
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('plain shell OFF'))
      await page.waitForFunction(() => document.querySelector('.terminal-jog').hidden)
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    throw error
  }
}
