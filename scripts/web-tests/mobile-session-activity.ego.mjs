import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run() {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-session-activity')
  await mkdir(output, { recursive: true })
  const task = await taskSpace('QingCode session activity 20261104')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const count = () => page.evaluate(() => window.__mobileFixture.state.sessionRequests.length)
  const refresh = async () => {
    const previous = await count()
    await page.waitForFunction(n => window.__mobileFixture.state.sessionRequests.length > n, previous)
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto('http://127.0.0.1:38439/mobile-android/')
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.waitForFunction(() => !!window.__mobileFixture && !!window.qingLink)
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764, undefined, '公司电脑')))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'show trusted projects' })
    await page.click('#project-list .row:first-child', { label: 'open fixture terminal' })
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await page.evaluate(() => {
      const fixture = window.__mobileFixture
      const first = fixture.state.sessions.get('mobile-1')
      fixture.setTitle('mobile-1', '⠋ 优化 CTRL+C 与图片样式 | QingCode')
      fixture.state.sessions.set('mobile-2', { ...first, id: 'mobile-2', number: 2, title: '⠙ 优化底部输入框样式 | QingCode', nameRevision: 1, output: [], waiters: [] })
    })
    await page.click('#show-sessions', { label: 'open running sessions' })
    await step('both running sessions animate independently of the selected output stream', async () => {
      await page.waitForFunction(() => document.querySelectorAll('.session-option[data-running="true"]').length === 2)
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.session-spinner')].every(node => getComputedStyle(node).animationName === 'spin')))
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.session-label')].every(node => !/[\u2800-\u28ff]/u.test(node.textContent))))
      assert.ok(await page.evaluate(() => window.__mobileFixture.state.polls.every(request => request.id === 'mobile-1')))
      await page.evaluate(() => {
        window.__activityRow = document.querySelector('.session-option[data-id="mobile-2"]')
        window.__activitySpinner = window.__activityRow.querySelector('.session-spinner')
      })
      const before = await page.evaluate(() => getComputedStyle(window.__activitySpinner).transform)
      await page.waitForFunction(value => getComputedStyle(window.__activitySpinner).transform !== value, before)
    })
    await page.screenshot({ path: resolve(output, 'two-running-sessions.png') })
    await step('unselected session completion updates while the drawer stays open', async () => {
      await page.evaluate(() => window.__mobileFixture.setTitle('mobile-2', '优化底部输入框样式 | QingCode'))
      await page.waitForFunction(() => document.querySelector('.session-option[data-id="mobile-2"]').dataset.running === 'false')
      assert.ok(await page.evaluate(() => window.__activityRow === document.querySelector('.session-option[data-id="mobile-2"]')
        && window.__activitySpinner === document.querySelector('.session-option[data-id="mobile-2"] .session-spinner')))
    })
    await step('manual names retain activity and ended terminals stop animating', async () => {
      await page.evaluate(() => {
        const session = window.__mobileFixture.state.sessions.get('mobile-2')
        session.customName = '发布与构建'
        window.__mobileFixture.setTitle('mobile-2', '⠙ 正在构建')
      })
      await page.waitForFunction(() => document.querySelector('.session-option[data-id="mobile-2"]').dataset.running === 'true')
      assert.equal(await page.evaluate(() => document.querySelector('.session-option[data-id="mobile-2"] .session-label').textContent), '发布与构建')
      await page.evaluate(() => { window.__mobileFixture.state.sessions.get('mobile-2').exit = { exitCode: 0 } })
      await page.waitForFunction(() => document.querySelector('.session-option[data-id="mobile-2"] small').textContent.includes('已结束'))
      assert.equal(await page.evaluate(() => document.querySelector('.session-option[data-id="mobile-2"]').dataset.running), 'false')
    })
    await step('refresh failures retain rows and recover automatically', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.sessionError = '模拟刷新失败' })
      await page.waitForFunction(() => !document.querySelector('#session-error').hidden)
      assert.equal(await page.evaluate(() => document.querySelectorAll('.session-option').length), 2)
      await page.evaluate(() => { window.__mobileFixture.state.sessionError = null })
      await page.waitForFunction(() => document.querySelector('#session-error').hidden)
    })
    await step('narrow layout and reduced motion preserve readable running status', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
      await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
        && document.querySelector('#session-options').scrollWidth <= document.querySelector('#session-options').clientWidth))
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.session-spinner')).animationName), 'none')
      assert.match(await page.evaluate(() => document.querySelector('.session-option small').textContent), /运行中/)
    })
    await page.screenshot({ path: resolve(output, 'narrow-reduced-motion.png') })
    await step('native background pauses refresh and foreground resumes it', async () => {
      await page.evaluate(() => window.qingVisibility(false))
      const before = await count()
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1750)))
      assert.equal(await count(), before)
      await page.evaluate(() => window.qingVisibility(true))
      await page.waitForFunction(n => window.__mobileFixture.state.sessionRequests.length > n, before)
    })
    await step('closed drawer stops metadata traffic', async () => {
      await page.click('#session-drawer [data-close]', { label: 'close session drawer' })
      const before = await count()
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1750)))
      assert.equal(await count(), before)
    })
    await step('slow refreshes cannot restore stale activity or undo manual names', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.sessionDelay = 700 })
      await page.click('#show-sessions', { label: 'open delayed session list' })
      await page.evaluate(() => window.__mobileFixture.setTitle('mobile-1', '更新后的会话标题'))
      await page.waitForFunction(() => document.querySelector('#terminal-name').textContent === '更新后的会话标题')
      await refresh()
      await page.waitForFunction(() => document.querySelector('.session-option[data-id="mobile-1"]').dataset.running === 'false')
      assert.equal(await page.evaluate(() => document.querySelector('.session-option[data-id="mobile-1"] .session-label').textContent), '更新后的会话标题')
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, results, error: String(error) })
    throw error
  }
}
