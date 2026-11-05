import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 手机会话操作菜单：⋯ / 长按打开，置顶（仅手机本地）、重命名、结束非当前会话。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-session-actions')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile session actions 20261104')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const settle = selector => page.waitForFunction(selector => !document.querySelector(selector).getAnimations().some(animation => animation.playState === 'running'), selector)
  const drawer = async () => {
    await page.click('#show-sessions', { label: 'open session drawer' })
    await page.waitForSelector('#session-drawer[open]')
    await settle('#session-drawer')
  }
  const order = () => page.evaluate(() => [...document.querySelectorAll('#session-options .session-option')].map(row => row.querySelector('.session-label').textContent))
  const actions = async (position, label) => {
    await page.click(`#session-options .session-option:nth-child(${position}) .session-more`, { label })
    await page.waitForSelector('#session-actions-dialog[open]')
    await settle('#session-actions-dialog')
  }
  const touchHold = async (selector, ms) => {
    const point = await page.evaluate(selector => {
      const box = document.querySelector(selector).getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }, selector)
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await page.waitForTimeout(ms)
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  const renameCurrent = async value => {
    await page.click('#session-options .session-option[data-current="true"] .session-more', { label: 'current session actions' })
    await page.waitForSelector('#session-actions-dialog[open]')
    await settle('#session-actions-dialog')
    await page.click('#session-action-rename', { label: 'rename from actions' })
    await page.fill('#session-name-input', value)
    await page.click('#save-session-name', { label: 'save session name' })
    await page.waitForFunction(() => !document.querySelector('#rename-session-dialog').open)
  }
  const newSession = async count => {
    await page.click('#drawer-new-session', { label: 'add session' })
    await page.click('[data-profile="default"]', { label: 'start plain shell' })
    await page.waitForFunction(count => document.querySelector('#terminal-status').textContent === '会话中'
      && window.__mobileFixture.state.sessions.size === count, count)
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
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

    await step('three named sessions keep desktop order before anything is pinned', async () => {
      await drawer()
      await renameCurrent('甲 构建')
      await newSession(2)
      await drawer()
      await renameCurrent('乙 测试')
      await newSession(3)
      await drawer()
      await renameCurrent('丙 部署')
      assert.deepEqual(await order(), ['甲 构建', '乙 测试', '丙 部署'])
    })

    await step('⋯ opens the actions sheet with pin, rename and end', async () => {
      await actions(2, 'open second session actions')
      await settle('#session-actions-dialog')
      const sheet = await page.evaluate(() => ({
        title: document.querySelector('#session-actions-title').textContent,
        pin: document.querySelector('#session-action-pin').textContent,
        end: document.querySelector('#session-action-end').textContent,
      }))
      assert.deepEqual(sheet, { title: '乙 测试', pin: '置顶', end: '结束会话' })
    })
    await page.screenshot({ path: resolve(output, 'actions-sheet.png') })

    await step('pinning moves a session to the top with a marker, newest pin first', async () => {
      await page.click('#session-action-pin', { label: 'pin second session' })
      await page.waitForFunction(() => !document.querySelector('#session-actions-dialog').open)
      assert.deepEqual(await order(), ['乙 测试', '甲 构建', '丙 部署'])
      assert.equal(await page.evaluate(() => document.querySelector('#session-options .session-option:first-child').dataset.pinned), 'true')
      assert.match(await page.evaluate(() => document.querySelector('#session-options .session-option:first-child small').textContent), /^已置顶/)
      await actions(3, 'open third session actions')
      await page.click('#session-action-pin', { label: 'pin third session' })
      assert.deepEqual(await order(), ['丙 部署', '乙 测试', '甲 构建'])
    })
    await page.screenshot({ path: resolve(output, 'pinned-order.png') })

    await step('a touch long press opens the same sheet without switching sessions', async () => {
      const current = await page.evaluate(() => document.querySelector('#terminal-name').textContent)
      await touchHold('#session-options .session-option:nth-child(2) .row', 800)
      await page.waitForSelector('#session-actions-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#session-actions-title').textContent), '乙 测试')
      assert.equal(await page.evaluate(() => document.querySelector('#session-action-pin').textContent), '取消置顶')
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), true)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-name').textContent), current)
      await page.evaluate(() => window.qingBack())
      assert.equal(await page.evaluate(() => document.querySelector('#session-actions-dialog').open), false)
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), true)
    })

    // CDP 两次触摸事件之间的实际间隔可达 1 秒，无法稳定模拟短按；短按计时由 Vitest 覆盖，这里用普通点击。
    await step('a plain tap still switches sessions', async () => {
      await page.click('#session-options .session-option:nth-child(3) .row', { label: 'tap third session' })
      await page.waitForFunction(() => document.querySelector('#terminal-name').textContent === '甲 构建')
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), false)
    })

    await step('pins survive leaving and resuming the project without touching the computer', async () => {
      const renames = await page.evaluate(() => [...window.__mobileFixture.state.sessions.values()].map(item => item.name))
      await drawer()
      await page.click('#back', { label: 'return to dashboard' })
      await page.click('#dashboard-nav [data-page="home"]', { label: 'show terminal home' })
      await page.click('#resume', { label: 'resume pinned project' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await drawer()
      assert.deepEqual(await order(), ['丙 部署', '乙 测试', '甲 构建'])
      // 电脑端的会话顺序与名称不因手机置顶而改变。
      assert.deepEqual(await page.evaluate(() => [...window.__mobileFixture.state.sessions.values()].map(item => item.name)), renames)
    })

    await step('unpinning restores desktop order for that session', async () => {
      await actions(1, 'open pinned session actions')
      await page.click('#session-action-pin', { label: 'unpin third session' })
      assert.deepEqual(await order(), ['乙 测试', '甲 构建', '丙 部署'])
    })

    await step('ending a non-current session keeps the drawer, the current session and drops its pin', async () => {
      await actions(1, 'open pinned session actions')
      await page.click('#session-action-end', { label: 'end second session' })
      await page.waitForSelector('#confirm-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#confirm-title').textContent), '关闭会话？')
      await page.click('#confirm-action', { label: 'confirm ending session' })
      await page.waitForFunction(() => document.querySelectorAll('#session-options .session-option').length === 2)
      assert.deepEqual(await order(), ['甲 构建', '丙 部署'])
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), true)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-name').textContent), '甲 构建')
      assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('session-pins:'))
        .map(key => localStorage.getItem(key)).join('')), '')
    })

    await step('narrow screens fit the actions sheet', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
      await actions(2, 'open narrow actions')
      await settle('#session-actions-dialog')
      assert.ok(await page.evaluate(() => {
        const box = document.querySelector('#session-actions-dialog').getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth
      }))
    })
    await page.screenshot({ path: resolve(output, 'actions-narrow.png') })
    await page.evaluate(() => window.qingBack())

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results })
    throw error
  }
}
