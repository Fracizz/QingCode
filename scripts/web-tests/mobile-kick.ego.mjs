import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 电脑「断开其他端」：手机退回首页并提示；网络出错后的自动重连不能悄悄接回，用户重新打开才恢复。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-kick')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile kick 20261114')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const shot = name => page.screenshot({ path: resolve(output, `${name}.png`) }).catch(() => {})
  const NOTICE = '电脑已断开本机与此终端的连接，可重新打开'
  const attaches = () => page.evaluate(() => window.__mobileFixture.state.attaches.filter(item => item.id === 'term-9'))
  const kickedHome = () => page.waitForFunction(notice => {
    const toast = document.querySelector('#sort-toast')
    return document.querySelector('#terminal-screen').hidden && toast && !toast.hidden && toast.textContent === notice
  }, NOTICE, { timeout: 8000 })
  const openTerminal = async () => {
    await page.click('#dashboard-nav [data-page="home"]', { label: 'show terminal home' })
    await page.waitForSelector('#home-session-overview [data-id="term-9"] .row')
    await page.click('#home-session-overview [data-id="term-9"] .row', { label: 'open shared desktop terminal' })
  }
  const writable = () => page.waitForFunction(() => !document.querySelector('#terminal-screen').hidden && !document.querySelector('#send').disabled)
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
    await openTerminal()
    await page.waitForSelector('#terminal-take-back')
    await page.click('#terminal-take-back', { label: 'take control' })
    await writable()

    await step('kick while polling: back to home with a notice', async () => {
      await page.evaluate(() => window.__mobileFixture.kick('term-9'))
      await kickedHome()
      await shot('01-kicked-home')
    })

    await step('reopening the terminal by hand rejoins it', async () => {
      await page.waitForFunction(() => document.querySelector('#sort-toast').hidden, null, { timeout: 8000 })
      await openTerminal()
      await writable()
      assert.equal((await attaches()).at(-1).rejoin, true)
      await page.waitForTimeout(1200)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-screen').hidden), false)
    })

    await step('kick hidden behind a network error: the automatic reattach does not rejoin silently', async () => {
      const before = (await attaches()).length
      await page.evaluate(() => window.__mobileFixture.kick('term-9', { errors: 1 }))
      await kickedHome()
      const after = await attaches()
      assert.ok(after.length > before, 'phone reattached after the network error')
      assert.equal(after.at(-1).rejoin, false)
      // 断开答复说明电脑可达，首页不能停在「电脑暂时不可达」。
      await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online', null, { timeout: 4000 })
      await shot('02-kicked-after-network-error')
    })

    await step('the kicked terminal still reopens by hand afterwards', async () => {
      await page.waitForFunction(() => document.querySelector('#sort-toast').hidden, null, { timeout: 8000 })
      await openTerminal()
      await writable()
      assert.equal((await attaches()).at(-1).rejoin, true)
      await shot('03-reopened')
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results }, null, 2))
    console.log({ output, results, spaceId: task.spaceId })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await shot('failure')
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error), spaceId: task.spaceId }, null, 2))
    console.log({ output, results, error: String(error), spaceId: task.spaceId })
    throw error
  }
}
