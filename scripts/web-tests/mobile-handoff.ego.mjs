import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 终端独占接入：显式接管、被顶提示、接回、重连不抢，以及「全部会话」中的电脑终端。
// 只操作内存桥，不替代真实电脑终端转发、Android 真机与多设备验收。
export async function run({ spaceId, finish = true, base = 'http://127.0.0.1:38439' } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-handoff')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal handoff 20261108')
  const page = task.page('p1')
  console.log({ spaceId: task.spaceId })
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const text = selector => page.evaluate(target => document.querySelector(target)?.textContent ?? '', selector)
  const attaches = () => page.evaluate(() => window.__mobileFixture.state.attaches)
  const waitOnline = () => page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
  const waitTaken = () => page.waitForFunction(() => !document.querySelector('#terminal-taken').hidden)
  const shot = name => page.screenshot({ path: resolve(output, name + '.png').replaceAll('\\', '/') })
  const goHome = async () => {
    await page.evaluate(() => { while (window.qingBack()) { /* 逐层返回工作台首页 */ } })
    await page.waitForFunction(() => !document.querySelector('#home-screen').hidden)
  }
  const openFirstProject = async () => {
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list > :first-child .project-row:first-child .row')
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
    await page.goto(base + '/mobile-android/', { timeout: 60000 })
    await page.snapshot()
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => {
      const state = window.__mobileFixture.state
      state.capabilities = { ...state.capabilities, features: [...state.capabilities.features, 'handoff'] }
    })
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.evaluate(() => window.qingOrientation(false))
    await openFirstProject()
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await waitOnline()

    await step('entering a session claims it and input carries the lease', async () => {
      const [first] = await attaches()
      assert.equal(first.id, 'mobile-1')
      await page.evaluate(() => window.__mobileFixture.state.inputs.length = 0)
      await page.fill('#compose', 'echo hi')
      await page.click('#send')
      await page.waitForFunction(() => window.__mobileFixture.state.leasedInputs.length > 0)
    })

    await step('being taken over shows the notice, hides the tools and stops polling', async () => {
      await page.evaluate(() => window.__mobileFixture.takeOver('mobile-1', '平板'))
      await waitTaken()
      assert.equal(await text('#terminal-taken-text'), '已在 平板 上接入')
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#terminal-tools')).display), 'none')
      await shot('taken-over')
      const before = await page.evaluate(() => window.__mobileFixture.state.polls.length)
      await new Promise(done => setTimeout(done, 1500))
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.polls.length), before)
    })

    await step('take back claims the session again with an explicit take', async () => {
      await page.click('#terminal-take-back')
      await waitOnline()
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-taken').hidden), true)
      assert.equal((await attaches()).at(-1).take, true)
    })

    await step('resuming the last screen never steals the terminal', async () => {
      await goHome()
      await page.evaluate(() => window.__mobileFixture.takeOver('mobile-1', '平板'))
      await openFirstProject()
      await waitTaken()
      const last = (await attaches()).at(-1)
      assert.equal(last.take, false)
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.sessions.get('mobile-1').holder), '平板')
    })

    await step('computer terminals join all sessions with their source and current user', async () => {
      await page.evaluate(() => window.__mobileFixture.addDesktopTerminal({ id: 'term-9', project: 'p-ssh', title: 'claude' }))
      await goHome()
      const row = '#home-session-overview [data-id="term-9"]'
      await page.waitForSelector(row)
      const small = await text(row + ' small')
      assert.match(small, /电脑终端/)
      assert.match(small, /在 电脑 上使用中/)
      await shot('overview')
    })

    await step('batch management leaves computer terminals out', async () => {
      await page.click('#home-sessions .overview-manage')
      await page.click('#home-session-overview .overview-select-all')
      const row = '#home-session-overview [data-id="term-9"]'
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.checked, row), 'false')
      assert.equal(await page.evaluate(selector => document.querySelector(selector + ' .row').disabled, row), true)
      await page.click('#home-sessions .overview-manage')
    })

    await step('tapping a computer terminal takes it over and it stays out of the project list', async () => {
      await page.click('#home-session-overview [data-id="term-9"] .row')
      await page.waitForFunction(() => window.__mobileFixture.state.attaches.at(-1).id === 'term-9')
      await waitOnline()
      assert.equal((await attaches()).at(-1).take, true)
      const requests = await page.evaluate(() => window.__mobileFixture.state.sessionRequests)
      assert.ok(requests.some(item => item.desktop === true))
      await shot('computer-terminal')
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png').replaceAll('\\', '/') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    throw error
  }
}
