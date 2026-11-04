import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-recent-sessions')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile recent and sessions 20261104')
  const page = task.page('p1')
  const results = []
  const step = async (name, action) => { await action(); results.push({ name, passed: true }) }
  // 窗口被遮挡时 page.screenshot() 可能挂起：拉到前台后用 CDP 截图，失败只记录。
  const shot = async name => {
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await page.cdp('Page.bringToFront')
    // 截图只是附件：超时时记录后继续执行断言。
    const capture = await page.cdp('Page.captureScreenshot', { format: 'png' }, { timeout: 8000 }).catch(error => {
      skippedShots.push({ name, error: String(error?.message ?? error) })
      return null
    })
    if (capture) await writeFile(resolve(output, name), Buffer.from(capture.data, 'base64'))
    // 截图超时后 Ego 可能丢失模拟视口，恢复截图前的尺寸。
    await page.cdp('Emulation.setDeviceMetricsOverride', { ...metrics, deviceScaleFactor: 1, mobile: true })
  }
  const skippedShots = []
  const names = () => page.evaluate(() => [...document.querySelectorAll('#home-project-list strong')].map(item => item.textContent))
  const pair = async (port, name) => {
    await page.evaluate(({ port, name }) => window.qingLink(window.__mobileFixture.link('192.168.1.8', port, undefined, name)), { port, name })
    await page.waitForSelector('#pair-dialog[open]')
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(name => document.querySelector('#active-host-name').textContent === name
      && document.querySelector('#active-host').dataset.state === 'online', name)
  }
  const home = () => page.click('#dashboard-nav [data-page="chat"]', { label: 'show chats' }).then(() => page.click('#chat-terminals', { label: 'show terminal home' }))
  const confirmAll = async () => {
    await page.click('#end-all-sessions', { label: 'end project sessions' })
    await page.waitForSelector('#confirm-dialog[open]')
    await page.click('#confirm-action', { label: 'confirm all session endings' })
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(baseUrl + '/mobile-android/')
    // Only this localhost fixture's app records are reset; no browser-wide storage operations.
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
    await page.reload()
    await page.waitForFunction(() => document.querySelector('#home-empty-title').textContent === '连接一台 QingCode')
    await page.evaluate(() => {
      window.__mobileFixture.state.projects = Array.from({ length: 15 }, (_, i) => ({
        id: 'p' + i, name: 'Project ' + i, kind: 'local', host: 'Windows', path: 'D:/code/project-' + i,
        lastOpenedAt: Date.now() - 100000 + i,
      }))
    })
    await pair(48764, '电脑 A')
    await home()
    await step('recent projects use actual opening times and show at most ten', async () => {
      assert.equal(await page.evaluate(() => document.querySelector('#home-projects-title').textContent), '最近打开')
      assert.deepEqual(await names(), Array.from({ length: 10 }, (_, i) => 'Project ' + (14 - i)))
    })
    await shot('recent-top.png')
    await step('the home page scrolls to the last recent project while navigation stays fixed', async () => {
      const navTop = await page.evaluate(() => document.querySelector('#dashboard-nav').getBoundingClientRect().top)
      await page.mouse.move(200, 600)
      await page.mouse.wheel(0, 1400, { label: 'scroll recent project list' })
      await page.waitForFunction(() => document.querySelector('#home-screen').scrollTop > 0)
      assert.equal(await page.evaluate(() => document.querySelector('#dashboard-nav').getBoundingClientRect().top), navTop)
      assert.ok(await page.evaluate(() => document.querySelector('#home-screen').scrollHeight > document.querySelector('#home-screen').clientHeight
        && document.documentElement.scrollWidth <= innerWidth))
    })
    await shot('recent-bottom.png')
    await step('opening a project moves it to the top and saves its history', async () => {
      await page.click('#home-project-list .row:last-child', { label: 'open older recent project' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await page.click('#show-sessions', { label: 'open session drawer' })
      await page.waitForSelector('#session-drawer[open]')
      await page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
      await page.click('#back', { label: 'return to recent projects' })
      assert.equal((await names())[0], 'Project 5')
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qingcode:mobile:recent-projects:192.168.1.8:48764'))[0].id), 'p5')
    })
    await step('older computers use phone history and separate computers keep separate records', async () => {
      await page.evaluate(() => { for (const item of window.__mobileFixture.state.projects) delete item.lastOpenedAt })
      await page.click('#dashboard-nav [data-page="project"]', { label: 'open all projects' })
      await page.click('#refresh', { label: 'refresh legacy project data' })
      await page.waitForFunction(() => !document.querySelector('#refresh').disabled)
      await home()
      assert.deepEqual(await names(), ['Project 5'])
      await pair(49000, '电脑 B')
      await home()
      assert.deepEqual(await names(), [])
      assert.equal(await page.evaluate(() => document.querySelector('#home-recent-empty').hidden), false)
      await page.click('#dashboard-nav [data-page="connection"]', { label: 'choose first computer' })
      await page.click('#connection-list .connection-card:first-child .connection-main', { label: 'switch to computer A' })
      await page.waitForFunction(() => document.querySelector('#active-host-name').textContent === '电脑 A'
        && document.querySelector('#active-host').dataset.state === 'online')
      assert.deepEqual(await names(), ['Project 5'])
    })
    await home()
    await page.click('#home-all-projects', { label: 'browse all projects' })
    await page.click('#project-list .row:first-child', { label: 'open batch session project' })
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    for (let i = 0; i < 2; i++) {
      await page.click('#new-session', { label: 'add a project session' })
      await page.click('[data-launch="shell"]', { label: 'create shell terminal' })
      await page.waitForFunction(count => [...window.__mobileFixture.state.sessions.values()].filter(item => item.project === 'p0').length === count
        && document.querySelector('#terminal-status').textContent === '会话中', i + 2)
    }
    await page.evaluate(() => {
      const first = [...window.__mobileFixture.state.sessions.values()].find(item => item.project === 'p0')
      first.exit = { exitCode: 0, disconnected: false }
      window.__mobileFixture.state.endErrors.add(first.id)
    })
    await page.click('#show-sessions', { label: 'manage current project sessions' })
    await page.waitForSelector('#session-drawer[open]')
    await page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
    await page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
    await page.evaluate(() => document.querySelector('#end-all-sessions').scrollIntoView({ block: 'end' }))
    assert.ok(await page.evaluate(() => {
      const bounds = document.querySelector('#end-all-sessions').getBoundingClientRect()
      return bounds.left >= -1 && bounds.right <= innerWidth + 1 && bounds.height >= 43.5
    }))
    await shot('all-sessions-narrow.png')
    await step('ending all sessions asks for the project and count and cancellation has no effect', async () => {
      await page.click('#end-all-sessions', { label: 'review all session endings' })
      await page.waitForSelector('#confirm-dialog[open]')
      const message = await page.evaluate(() => document.querySelector('#confirm-text').textContent)
      assert.match(message, /电脑 A \/ Project 0/)
      assert.match(message, /3 个手机会话/)
      await shot('confirm-all.png')
      await page.click('#confirm-dialog [value="cancel"]', { label: 'cancel all session endings' })
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.ends.length), 0)
    })
    await step('partial failure keeps the failed session and other projects intact', async () => {
      await confirmAll()
      await page.waitForFunction(() => document.querySelector('#session-drawer').open
        && !document.querySelector('#session-error').hidden)
      assert.match(await page.evaluate(() => document.querySelector('#session-error').textContent), /已结束 2 个会话，1 个未确认结束/)
      assert.deepEqual(await page.evaluate(() => [...window.__mobileFixture.state.sessions.values()].map(item => item.project).sort()), ['p0', 'p5'])
    })
    await shot('partial-failure.png')
    await step('retry ends only the remaining project session and returns home', async () => {
      await page.evaluate(() => window.__mobileFixture.state.endErrors.clear())
      await confirmAll()
      await page.waitForFunction(() => document.querySelector('#terminal-screen').hidden && !document.querySelector('#home-screen').hidden)
      assert.deepEqual(await page.evaluate(() => [...window.__mobileFixture.state.sessions.values()].map(item => item.project)), ['p5'])
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results, skippedShots }, null, 2))
    console.log({ output, results, skippedShots })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results })
    throw error
  }
}
