import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 平板适配：双栏默认收起、侧栏按钮展开 / 收起并记住、横屏手机与分屏窄窗口退回抽屉、实体键盘自动收起快捷键栏。
 * 设备模拟同时设置 screenWidth / screenHeight，页面按设备最短边判断平板。
 */
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-tablet')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile tablet layout 20261107')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const device = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', {
    width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: true,
  })
  const docked = () => page.evaluate(() => {
    const drawer = document.querySelector('#session-drawer')
    return drawer.open && drawer.dataset.docked === 'true' && !drawer.matches(':modal')
  })
  const settle = () => page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
  try {
    await device(1280, 800)
    await page.goto(baseUrl + '/mobile-android/')
    const bounds = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId })
    if (bounds.bounds.windowState === 'minimized') await task.cdp('Browser.setWindowBounds', { windowId: bounds.windowId, bounds: { windowState: 'normal' } })
    await page.cdp('Page.bringToFront')
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await device(1280, 800)
    await page.waitForFunction(() => document.querySelector('#home-empty-title').textContent === '连接一台 QingCode')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764, undefined, '工作电脑')))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair test computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')

    await step('dashboard on a tablet keeps the drawer closed', async () => {
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), false)
    })
    await page.click('#dashboard-nav [data-page="project"]', { label: 'browse projects' })
    await page.click('#project-list > :first-child .project-row:first-child .row', { label: 'open terminal project' })
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')

    await step('tablet terminal starts with the session sidebar collapsed', async () => {
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), false)
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#show-sessions')).display !== 'none'), true)
      assert.ok(await page.evaluate(() => document.querySelector('#viewport').getBoundingClientRect().left < 20))
    })
    await page.screenshot({ path: resolve(output, 'tablet-collapsed.png') })

    await step('the sidebar button expands a docked session list beside the output without a backdrop', async () => {
      await page.click('#show-sessions', { label: 'expand docked sessions' })
      await page.waitForFunction(() => document.querySelector('#session-drawer').open)
      assert.equal(await docked(), true)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:sessions-docked')), 'true')
      assert.equal(await page.evaluate(() => document.querySelector('#show-sessions').getAttribute('aria-expanded')), 'true')
      await settle()
      const layout = await page.evaluate(() => {
        const drawer = document.querySelector('#session-drawer').getBoundingClientRect()
        const viewport = document.querySelector('#viewport').getBoundingClientRect()
        return {
          drawerRight: drawer.right, viewportLeft: viewport.left,

          closeHidden: getComputedStyle(document.querySelector('#session-drawer [data-close]')).display === 'none',
          overflow: document.documentElement.scrollWidth > innerWidth,
          titleWidth: document.querySelector('.terminal-heading').getBoundingClientRect().width,
        }
      })
      assert.ok(layout.viewportLeft >= layout.drawerRight - 1, JSON.stringify(layout))
      assert.ok(layout.closeHidden && !layout.overflow, JSON.stringify(layout))
      assert.ok(layout.titleWidth > 600, 'header title uses the remaining width: ' + JSON.stringify(layout))
      await page.fill('#compose', '平板草稿')
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '平板草稿')
    })
    await page.screenshot({ path: resolve(output, 'tablet-docked.png') })

    await step('creating and switching sessions keeps the docked list open', async () => {
      await page.click('#drawer-new-session', { label: 'new session from docked list' })
      await page.click('[data-profile="default"]', { label: 'start second shell' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中'
        && window.__mobileFixture.state.sessions.size === 2)
      await page.waitForFunction(() => document.querySelectorAll('#session-options .session-option').length === 2)
      assert.equal(await docked(), true)
      await page.click('#session-options .session-option:first-child .row', { label: 'switch back to first session' })
      await page.waitForFunction(() => document.querySelector('#session-options .session-option:first-child').dataset.current === 'true')
      assert.equal(await docked(), true)
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '平板草稿')
    })

    await step('docked list keeps refreshing session metadata', async () => {
      await page.evaluate(() => window.__mobileFixture.setTitle('mobile-1', 'Claude'))
      await page.waitForFunction(() => document.querySelector('#session-options').textContent.includes('Claude'))
    })

    await step('the sidebar button collapses the list and remembers the choice', async () => {
      await page.click('#show-sessions', { label: 'collapse docked sessions' })
      await page.waitForFunction(() => !document.querySelector('#session-drawer').open)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:sessions-docked')), 'false')
      await page.waitForFunction(() => document.querySelector('#viewport').getBoundingClientRect().left < 20)
      await page.click('#show-sessions', { label: 'expand again' })
      await page.waitForFunction(() => document.querySelector('#session-drawer').open)
      assert.equal(await docked(), true)
    })

    await step('Back leaves the terminal instead of closing the docked list, and undocks on the dashboard', async () => {
      await page.evaluate(() => window.qingBack())
      await page.waitForFunction(() => document.querySelector('#terminal-screen').hidden)
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), false)
      assert.equal(await page.evaluate(() => document.documentElement.dataset.sessionsDocked), 'false')
      await page.click('#dashboard-nav [data-page="home"]', { label: 'open home' })
      await page.click('#resume', { label: 'resume session' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await page.waitForFunction(() => document.querySelector('#session-drawer').open)
      assert.equal(await docked(), true)
    })

    await step('a narrow split-screen window falls back to the modal drawer', async () => {
      await device(600, 800)
      await page.waitForFunction(() => !document.querySelector('#session-drawer').open)
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#show-sessions')).display !== 'none'), true)
      await page.click('#show-sessions', { label: 'open drawer in split screen' })
      await page.waitForSelector('#session-drawer[open]')
      await settle()
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').matches(':modal')), true)
      await page.screenshot({ path: resolve(output, 'split-drawer.png') })
      await device(1280, 800)
      await page.waitForFunction(() => document.querySelector('#session-drawer').dataset.docked === 'true')
      assert.equal(await docked(), true)
    })

    await step('landscape phones wider than 840px keep the collapsible drawer', async () => {
      await device(915, 412)
      await page.waitForFunction(() => !document.querySelector('#session-drawer').open)
      assert.equal(await page.evaluate(() => document.documentElement.dataset.sessionsDocked), 'false')
      await device(1280, 800)
      await page.waitForFunction(() => document.querySelector('#session-drawer').open)
    })

    await step('a hardware keyboard collapses the shortcut row without changing the saved preference', async () => {
      await page.evaluate(() => window.qingOrientation(false))
      await page.waitForFunction(() => !document.querySelector('#special-keys').hidden)
      const saved = await page.evaluate(() => localStorage.getItem('qingcode:mobile:keys-collapsed'))
      await page.evaluate(() => window.qingHardKeyboard(true))
      await page.waitForFunction(() => document.querySelector('#special-keys').hidden)
      assert.equal(await page.evaluate(() => document.querySelector('#toggle-keys').getAttribute('aria-expanded')), 'false')
      await page.screenshot({ path: resolve(output, 'tablet-hardware-keyboard.png') })
      await page.click('#toggle-keys', { label: 'expand shortcuts with keyboard attached' })
      await page.waitForFunction(() => !document.querySelector('#special-keys').hidden)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:keys-collapsed')), saved)
      await page.evaluate(() => window.qingHardKeyboard(true))
      assert.equal(await page.evaluate(() => document.querySelector('#special-keys').hidden), false, 'repeated reports keep the manual choice')
      await page.evaluate(() => window.qingHardKeyboard(false))
      await page.waitForFunction(() => !document.querySelector('#special-keys').hidden)
      await page.evaluate(() => window.qingHardKeyboard(true))
      await page.waitForFunction(() => document.querySelector('#special-keys').hidden)
      await page.evaluate(() => window.qingHardKeyboard(false))
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results })
    throw error
  }
}
