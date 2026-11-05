import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run as recentRegression } from './mobile-recent-sessions.ego.mjs'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-sidebar')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile sidebar naming 20261104')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const drawer = async () => {
    await page.click('#show-sessions', { label: 'open session drawer' })
    await page.waitForSelector('#session-drawer[open]')
    await page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
  }
  // 重命名入口在会话操作菜单（⋯ / 长按）里。
  const openRename = async (selector, label) => {
    await page.click(selector + ' .icon-button', { label: label + ' (more actions)' })
    await page.waitForSelector('#session-actions-dialog[open]')
    await page.click('#session-action-rename', { label })
    await page.waitForSelector('#rename-session-dialog[open]')
  }
  const rename = async value => {
    await openRename('#session-options .session-option[data-current="true"]', 'rename current session')
    await page.fill('#session-name-input', value)
    await page.click('#save-session-name', { label: 'save session name' })
    await page.waitForFunction(() => !document.querySelector('#rename-session-dialog').open)
  }
  const waitName = value => page.waitForFunction(name => document.querySelector('#terminal-name').textContent === name, value)
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(baseUrl + '/mobile-android/')
    const bounds = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId })
    if (bounds.bounds.windowState === 'minimized') await task.cdp('Browser.setWindowBounds', { windowId: bounds.windowId, bounds: { windowState: 'normal' } })
    await page.cdp('Page.bringToFront')
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.waitForFunction(() => document.querySelector('#home-empty-title').textContent === '连接一台 QingCode')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764, undefined, '工作电脑')))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair test computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'browse trusted projects' })
    await page.click('#project-list .row:first-child', { label: 'open terminal project' })
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    const headHeight = await page.evaluate(() => document.querySelector('.terminal-head').getBoundingClientRect().height)
    await step('top tabs are replaced by a collapsible left drawer and program titles update the header', async () => {
      assert.equal(await page.evaluate(() => !!document.querySelector('#session-tabs')), false)
      await page.evaluate(() => window.__mobileFixture.setTitle('mobile-1', 'OpenCode'))
      await waitName('OpenCode')
      await drawer()
      assert.ok(await page.evaluate(() => {
        const box = document.querySelector('#session-drawer').getBoundingClientRect()
        return Math.abs(box.left) < 1 && box.width < innerWidth && box.height <= innerHeight + 1
      }))
      assert.match(await page.evaluate(() => document.querySelector('#session-options').textContent), /OpenCode/)
    })
    await page.screenshot({ path: resolve(output, 'drawer-portrait.png') })
    await step('manual rename takes priority over later program titles', async () => {
      await rename('登录问题排查')
      await waitName('登录问题排查')
      await page.click('#session-drawer [data-close]', { label: 'close session drawer' })
      const count = await page.evaluate(() => window.__mobileFixture.state.polls.length)
      await page.evaluate(() => window.__mobileFixture.setTitle('mobile-1', 'Claude'))
      await page.waitForFunction(count => window.__mobileFixture.state.polls.length > count, count)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-name').textContent), '登录问题排查')
    })
    await page.screenshot({ path: resolve(output, 'terminal-renamed.png') })
    await step('failed rename keeps the original name and exposes the error', async () => {
      await drawer()
      await page.evaluate(() => { window.__mobileFixture.state.renameError = '模拟网络失败' })
      await openRename('#session-options .session-option[data-current="true"]', 'edit current name')
      await page.fill('#session-name-input', '不会保存')
      await page.click('#save-session-name', { label: 'try failed rename' })
      await page.waitForFunction(() => !document.querySelector('#rename-session-error').hidden)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-name').textContent), '登录问题排查')
      await page.click('#rename-session-dialog [data-close]', { label: 'cancel failed rename' })
      await page.evaluate(() => { window.__mobileFixture.state.renameError = null })
    })
    await step('clearing a manual name restores the latest program title', async () => {
      await rename('')
      await waitName('Claude')
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.sessions.get('mobile-1').customName), null)
      await page.click('#session-drawer [data-close]', { label: 'return to terminal output' })
    })
    await step('switching named sessions closes the drawer and preserves their drafts', async () => {
      await page.fill('#compose', '第一会话的草稿')
      await drawer()
      await page.click('#drawer-new-session', { label: 'add named session' })
      await page.click('[data-profile="default"]', { label: 'start second shell' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中'
        && window.__mobileFixture.state.sessions.size === 2)
      assert.equal(await page.evaluate(() => document.querySelector('.terminal-head').getBoundingClientRect().height), headHeight)
      await drawer()
      await rename('发布与构建')
      await page.click('#session-options .session-option:first-child .row', { label: 'switch back to Claude' })
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), false)
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '第一会话的草稿')
      await waitName('Claude')
      await drawer()
      await page.click('#session-options .session-option:last-child .row', { label: 'select renamed build session' })
      await waitName('发布与构建')
    })
    await step('reopening the project fetches the saved name from the computer', async () => {
      await drawer()
      await page.click('#back', { label: 'return to dashboard' })
      await page.click('#dashboard-nav [data-page="chat"]', { label: 'show chats' }).then(() => page.click('#chat-terminals', { label: 'open resume home' }))
      await page.click('#resume', { label: 'resume named session' })
      await waitName('发布与构建')
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    })
    await step('narrow screens support long names and back closes rename then the drawer', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
      await drawer()
      await rename('构建和发布验证：很长的中文会话名称也能在侧边栏中正常换行')
      assert.ok(await page.evaluate(() => document.querySelector('#session-options').scrollWidth <= document.querySelector('#session-options').clientWidth
        && document.documentElement.scrollWidth <= innerWidth))
      await openRename('#session-options .session-option[data-current="true"]', 'review session rename')
      await page.evaluate(() => window.qingBack())
      assert.equal(await page.evaluate(() => document.querySelector('#rename-session-dialog').open), false)
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), true)
    })
    await page.screenshot({ path: resolve(output, 'drawer-narrow.png') })
    await page.evaluate(() => window.qingBack())
    await step('landscape exposes the same drawer through the terminal menu', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true })
      await page.evaluate(() => window.qingOrientation(true))
      await page.waitForFunction(() => window.__mobileFixture.state.fullscreen)
      await page.click('#terminal-menu', { label: 'open landscape terminal menu' })
      await page.click('#menu-sessions', { label: 'open landscape session drawer' })
      await page.waitForSelector('#session-drawer[open]')
      await page.waitForFunction(() => !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
      assert.ok(await page.evaluate(() => document.querySelector('#session-drawer').getBoundingClientRect().right <= innerWidth))
    })
    await page.screenshot({ path: resolve(output, 'drawer-landscape.png') })
    await page.evaluate(() => window.qingBack())
    await page.evaluate(() => window.qingOrientation(false))
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await step('older desktops keep numbered sessions and disable unavailable renaming', async () => {
      await drawer()
      await page.click('#back', { label: 'return before legacy reconnect' })
      await page.click('#dashboard-nav [data-page="chat"]', { label: 'show chats' }).then(() => page.click('#chat-terminals', { label: 'show legacy resume home' }))
      await page.evaluate(() => { window.__mobileFixture.state.sessionNames = false })
      await page.click('#resume', { label: 'resume from older desktop' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await drawer()
      await page.waitForFunction(() => !document.querySelector('#session-name-hint').hidden)
      await page.click('#session-options .session-option[data-current="true"] .icon-button', { label: 'open legacy session actions' })
      await page.waitForSelector('#session-actions-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#session-action-rename').disabled), true)
      await page.evaluate(() => window.qingBack())
      assert.match(await page.evaluate(() => document.querySelector('#terminal-name').textContent), /^终端 \d+$/)
    })
    await recentRegression({ spaceId: task.spaceId, baseUrl, artifactDir: resolve(output, 'recent-batch-regression'), finish: false })
    results.push({ name: 'recent projects and all-session cancellation, failure and retry regression', passed: true })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results })
    throw error
  }
}
