import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 安卓多端共享标签：标题副行显示短状态，点开弹层操作；共享状态变化不改变终端高度与行列。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-share-chip')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile share chip 20261114')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const shot = name => page.screenshot({ path: resolve(output, `${name}.png`) }).catch(() => {})
  const opened = async selector => {
    await page.waitForSelector(`${selector}[open]`)
    await page.waitForFunction(selector => !document.querySelector(selector).getAnimations().some(animation => animation.playState === 'running'), selector)
  }
  const chip = () => page.evaluate(() => {
    const button = document.querySelector('#terminal-share-chip')
    const box = button.getBoundingClientRect()
    return { hidden: button.hidden, label: button.querySelector('span').textContent, tone: button.dataset.tone, right: box.right, height: box.height, inHead: !!button.closest('.terminal-head') }
  })
  const desktop = { id: null, kind: 'desktop', name: '电脑', observe: false, typing: false, self: false }
  const self = { id: 'me', kind: 'device', name: 'Pixel', observe: false, typing: false, self: true }
  const tab = { id: 'tab', kind: 'device', name: 'Tab', observe: true, typing: false, self: false }
  const setShare = share => page.evaluate(share => window.__mobileFixture.setShare('term-9', share), share)
  const waitChip = (label, tone) => page.waitForFunction(([label, tone]) => {
    const button = document.querySelector('#terminal-share-chip')
    return !button.hidden && button.querySelector('span').textContent === label && (!tone || button.dataset.tone === tone)
  }, [label, tone])
  const ops = () => page.evaluate(() => window.__mobileFixture.state.shareOps ?? [])
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(baseUrl + '/mobile-android/')
    const bounds = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId })
    if (bounds.bounds.windowState === 'minimized') await task.cdp('Browser.setWindowBounds', { windowId: bounds.windowId, bounds: { windowState: 'normal' } })
    await page.cdp('Page.bringToFront')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.waitForFunction(() => typeof window.qingLink === 'function' && !!window.__mobileFixture)
    await page.evaluate(() => {
      const fixture = window.__mobileFixture
      fixture.state.capabilities.features.push('handoff', 'shared_view')
      fixture.addDesktopTerminal({ id: 'term-9', project: 'p-ssh', title: 'shared' })
      window.qingLink(fixture.link('192.168.1.8', 48764))
    })
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair test computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="home"]', { label: 'show terminal home' })
    await page.waitForSelector('#home-session-overview [data-id="term-9"] .row')
    await page.click('#home-session-overview [data-id="term-9"] .row', { label: 'open shared desktop terminal' })
    await page.waitForSelector('#terminal-take-back')
    await page.click('#terminal-take-back', { label: 'take control' })
    await page.waitForFunction(() => !document.querySelector('#send').disabled)
    await page.evaluate(() => window.__mobileFixture.pushScreen('term-9', 'shared-frame'))
    await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('shared-frame'))
    await page.waitForTimeout(500)
    const before = await page.evaluate(() => ({ rows: window.__mobileFixture.terminalSize().rows, body: document.querySelector('.terminal-body').getBoundingClientRect().height }))

    await step('only this device: no chip', async () => {
      assert.equal((await chip()).hidden, true)
    })

    await step('desktop joins: short idle chip in the header without resizing the terminal', async () => {
      await setShare({ viewers: [desktop, self] })
      await waitChip('电脑', 'idle')
      const state = await chip()
      assert.ok(state.inHead && state.right <= 390)
      await page.waitForTimeout(400)
      const after = await page.evaluate(() => ({ rows: window.__mobileFixture.terminalSize().rows, body: document.querySelector('.terminal-body').getBoundingClientRect().height }))
      assert.deepEqual(after, before)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    })
    await shot('01-chip-idle')

    await step('desktop typing highlights the chip', async () => {
      await setShare({ viewers: [{ ...desktop, typing: true }, self] })
      await waitChip('电脑 输入中', 'active')
    })
    await shot('02-chip-typing')

    await step('following the desktop size shows a notice; sheet offers my size', async () => {
      await setShare({ viewers: [desktop, self], sizeOwner: '电脑', sizeOwnerHere: false })
      await waitChip('按 电脑 尺寸', 'notice')
      await page.click('#terminal-share-chip', { label: 'open share sheet' })
      await opened('#share-dialog')
      const sheet = await page.evaluate(() => ({ text: document.querySelector('#share-text').textContent, size: !document.querySelector('#share-size').hidden }))
      assert.ok(sheet.text.includes('按 电脑 的尺寸显示') && sheet.size, JSON.stringify(sheet))
    })
    await shot('03-share-sheet')

    await step('use my size closes the sheet, sends take_size and returns to idle', async () => {
      await page.click('#share-size', { label: 'use my size' })
      await page.waitForFunction(() => !document.querySelector('#share-dialog').open)
      await page.waitForFunction(() => window.__mobileFixture.state.shareOps?.at(-1)?.op === 'take_size')
      await waitChip('电脑', 'idle')
    })

    await step('terminal menu has the share entry and opens the same sheet', async () => {
      await page.click('#terminal-menu', { label: 'open terminal menu' })
      await opened('#terminal-menu-dialog')
      assert.equal(await page.evaluate(() => document.querySelector('#menu-share').hidden), false)
      await page.click('#menu-share', { label: 'open share from menu' })
      await opened('#share-dialog')
      assert.deepEqual(await page.evaluate(() => [document.querySelector('#share-size').hidden, document.querySelector('#share-exclusive-label').textContent]), [true, '独占'])
    })

    await step('exclusive turns the chip into the strong state', async () => {
      await page.click('#share-exclusive', { label: 'take exclusive' })
      await waitChip('已独占', 'strong')
      const last = (await ops()).at(-1)
      assert.deepEqual([last.op, last.on], ['exclusive', true])
    })
    await shot('04-chip-exclusive')

    await step('sheet shows release while exclusive; back closes the sheet first', async () => {
      await page.click('#terminal-share-chip', { label: 'reopen share sheet' })
      await opened('#share-dialog')
      assert.equal(await page.evaluate(() => document.querySelector('#share-exclusive-label').textContent), '解除独占')
      await page.evaluate(() => window.qingBack())
      assert.deepEqual(await page.evaluate(() => [document.querySelector('#share-dialog').open, document.querySelector('#terminal-screen').hidden]), [false, false])
    })

    await step('alone again: chip and menu entry hide', async () => {
      await setShare({ viewers: [self] })
      await page.waitForFunction(() => document.querySelector('#terminal-share-chip').hidden)
      await page.click('#terminal-menu', { label: 'open terminal menu again' })
      await opened('#terminal-menu-dialog')
      assert.equal(await page.evaluate(() => document.querySelector('#menu-share').hidden), true)
      await page.evaluate(() => window.qingBack())
    })

    await step('several viewers show a count; 320px and landscape stay inside the viewport', async () => {
      await setShare({ viewers: [desktop, tab, self] })
      await waitChip('2', 'idle')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true })
      await page.waitForTimeout(300)
      assert.ok(await page.evaluate(() => {
        const box = document.querySelector('#terminal-share-chip').getBoundingClientRect()
        return box.right <= innerWidth && document.querySelector('#terminal-latency').getBoundingClientRect().width > 0 && document.documentElement.scrollWidth <= innerWidth
      }))
      await shot('05-narrow')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true })
      await page.waitForTimeout(300)
      const state = await chip()
      assert.ok(state.height > 0 && state.right <= 844)
      await shot('06-landscape')
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await shot('failure')
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results })
    throw error
  }
}
