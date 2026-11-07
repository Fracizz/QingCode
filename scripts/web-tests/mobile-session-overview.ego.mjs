import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 会话抽屉「全部」范围：这台电脑上所有项目的手机会话纵览。
// 只操作内存桥中的会话，不触碰电脑端真实进程；真实多项目 / 多设备仍需 APK 验收。
export async function run({ spaceId, finish = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-session-overview')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode session overview 20261107')
  const page = task.page('p1')
  console.log({ spaceId: task.spaceId })
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const drawer = async () => {
    if (!await page.evaluate(() => document.querySelector('#session-drawer').open)) await page.click('#show-sessions')
    await page.waitForFunction(() => document.querySelector('#session-drawer').open
      && !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
  }
  const groupIds = () => page.evaluate(() => [...document.querySelectorAll('#session-groups .session-group')].map(node => node.dataset.project))
  const rowIds = () => page.evaluate(() => [...document.querySelectorAll('#session-groups .session-option')].map(node => node.dataset.id))
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
    await page.goto('http://127.0.0.1:38439/mobile-android/', { timeout: 60000 })
    await page.snapshot()
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.evaluate(() => window.qingOrientation(false))
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list .row:first-child')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await page.fill('#compose', '本地项目草稿')
    // 其他项目与其他手机创建的会话；外加一个电脑端已移除项目中的会话。
    await page.evaluate(() => {
      const fixture = window.__mobileFixture
      fixture.setTitle('mobile-1', 'Claude Code')
      fixture.addSession({ project: 'p-ssh', title: '部署 api' })
      fixture.addSession({ project: 'p-ssh', title: 'vim 配置', deviceName: 'Galaxy Tab', ownDevice: false, exit: { code: 0 } })
      fixture.addSession({ project: 'p-gone', title: '旧任务', exit: { code: 1 },
        projectInfo: { id: 'p-gone', name: 'legacy', path: '/legacy', kind: 'wsl', host: '' } })
    })

    await step('project scope stays the default and only lists the current project', async () => {
      await drawer()
      assert.equal(await page.evaluate(() => document.querySelector('[data-scope="project"]').getAttribute('aria-checked')), 'true')
      assert.equal(await page.evaluate(() => document.querySelector('#session-overview').hidden), true)
      assert.equal(await page.evaluate(() => document.querySelectorAll('#session-options .session-option').length), 1)
      assert.ok((await page.evaluate(() => window.__mobileFixture.state.sessionRequests)).every(item => item.project === 'p-local'))
    })

    await step('all scope groups every project, current first, with device and removed-project labels', async () => {
      await page.click('[data-scope="all"]', { label: 'switch to all sessions' })
      await page.waitForFunction(() => document.querySelectorAll('#session-groups .session-option').length === 4)
      assert.deepEqual(await groupIds(), ['p-local', 'p-ssh', 'p-gone'])
      assert.deepEqual(await rowIds(), ['mobile-1', 'mobile-2', 'mobile-3', 'mobile-4'])
      const view = await page.evaluate(() => ({
        count: document.querySelector('#session-count').textContent,
        context: document.querySelector('#session-context').textContent,
        current: document.querySelector('#session-groups [data-current="true"]')?.dataset.id,
        other: document.querySelector('#session-groups [data-id="mobile-3"] small').textContent,
        gone: document.querySelector('[data-project="p-gone"] .session-group-source').textContent,
        filters: [...document.querySelectorAll('#session-filter button')].map(button => button.textContent),
        hidden: ['#session-options', '#drawer-new-session', '#end-all-sessions'].map(id => document.querySelector(id).hidden),
        clear: !document.querySelector('#clear-ended-sessions').hidden,
      }))
      assert.equal(view.count, '4')
      assert.match(view.context, /3 个项目/)
      assert.equal(view.current, 'mobile-1')
      assert.match(view.other, /来自 Galaxy Tab/)
      assert.match(view.gone, /电脑端已移除/)
      assert.deepEqual(view.filters, ['全部 4', '未结束 2', '已结束 2'])
      assert.deepEqual(view.hidden, [true, true, true])
      assert.ok(view.clear)
      const last = (await page.evaluate(() => window.__mobileFixture.state.sessionRequests)).at(-1)
      assert.equal(last.project, undefined, 'all scope reads every project in one request')
      await page.screenshot({ path: resolve(output, 'overview-390.png') })
    })

    await step('filter and multi-keyword search narrow the overview', async () => {
      await page.click('#session-filter [data-filter="exited"]')
      assert.deepEqual(await rowIds(), ['mobile-3', 'mobile-4'])
      await page.click('#session-filter [data-filter="live"]')
      assert.deepEqual(await rowIds(), ['mobile-1', 'mobile-2'])
      await page.click('#session-filter [data-filter="all"]')
      await page.fill('#session-search', 'api 部署')
      assert.deepEqual(await rowIds(), ['mobile-2'])
      await page.fill('#session-search', 'galaxy')
      assert.deepEqual(await rowIds(), ['mobile-3'])
      await page.fill('#session-search', '不存在')
      assert.equal(await page.evaluate(() => document.querySelector('#session-overview-empty').textContent), '没有符合条件的会话')
      await page.fill('#session-search', '')
      assert.equal((await rowIds()).length, 4)
    })

    await step('closing a session in another project keeps the current terminal and draft', async () => {
      await page.click('#session-groups [data-id="mobile-3"] .session-close')
      await page.waitForSelector('#confirm-dialog[open]')
      assert.match(await page.evaluate(() => document.querySelector('#confirm-text').textContent), /api-server \/ vim 配置/)
      await page.click('#confirm-action')
      await page.waitForFunction(() => !document.querySelector('#session-groups [data-id="mobile-3"]'))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.ends), ['mobile-3'])
      assert.equal(await page.evaluate(() => document.querySelector('#compose').value), '本地项目草稿')
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-status').textContent), '会话中')
    })

    await step('clear ended sessions removes only ended sessions across projects', async () => {
      await page.click('#clear-ended-sessions')
      await page.waitForSelector('#confirm-dialog[open]')
      assert.match(await page.evaluate(() => document.querySelector('#confirm-text').textContent), /1 个项目中 1 个已结束会话/)
      await page.click('#confirm-action')
      await page.waitForFunction(() => !document.querySelector('#session-groups [data-id="mobile-4"]'))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.ends), ['mobile-3', 'mobile-4'])
      assert.deepEqual(await rowIds(), ['mobile-1', 'mobile-2'])
      assert.equal(await page.evaluate(() => document.querySelector('#clear-ended-sessions').disabled), true)
    })

    await step('tapping a session in another project opens that project and session', async () => {
      await page.click('#session-groups [data-id="mobile-2"] .row', { label: 'open session in another project' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中'
        && document.querySelector('#terminal-host').textContent.includes('api-server'))
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-name').textContent), '部署 api')
      await drawer()
      await page.waitForFunction(() => document.querySelector('#session-groups [data-current="true"]')?.dataset.id === 'mobile-2')
      assert.deepEqual(await groupIds(), ['p-ssh', 'p-local'], 'the newly opened project moves to the top')
      assert.equal(await page.evaluate(() => document.querySelector('[data-scope="all"]').getAttribute('aria-checked')), 'true', 'scope is remembered')
    })

    await step('narrow and landscape layouts keep 44px actions without horizontal overflow', async () => {
      for (const [width, height] of [[320, 640], [844, 390]]) {
        await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, mobile: true, deviceScaleFactor: 1 })
        await page.evaluate(wide => window.qingOrientation(wide), width > 600)
        await page.waitForFunction(w => innerWidth === w, width)
        const layout = await page.evaluate(() => {
          const drawer = document.querySelector('#session-drawer').getBoundingClientRect()
          const actions = [...document.querySelectorAll('#session-groups .session-close')].map(button => {
            const box = button.getBoundingClientRect()
            return box.width >= 44 && box.height >= 44 && box.right <= drawer.right + 0.5
          })
          return { actions, overflow: document.documentElement.scrollWidth > innerWidth,
            footer: document.querySelector('#clear-ended-sessions').getBoundingClientRect().bottom <= innerHeight,
            // 至少第一行会话完整显示在底部按钮上方，矮屏下列表不能被挤没。
            firstRow: document.querySelector('#session-groups .session-option').getBoundingClientRect().bottom
              <= document.querySelector('.drawer-actions').getBoundingClientRect().top }
        })
        assert.ok(layout.actions.length && layout.actions.every(Boolean) && !layout.overflow && layout.footer && layout.firstRow, JSON.stringify(layout))
        await page.screenshot({ path: resolve(output, `overview-${width}x${height}.png`) })
      }
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
      await page.evaluate(() => window.qingOrientation(false))
    })

    await step('old desktops without all_sessions keep the project scope and explain why', async () => {
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
      })
      await page.reload()
      await page.waitForFunction(() => typeof window.qingLink === 'function')
      // 内存桥随页面重载重置，重载后再模拟不支持 all_sessions 的旧电脑端。
      await page.evaluate(() => {
        const fixture = window.__mobileFixture.state
        fixture.capabilities = { ...fixture.capabilities, features: fixture.capabilities.features.filter(item => item !== 'all_sessions') }
      })
      await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit')
      await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
      await page.evaluate(() => window.qingOrientation(false))
      await page.click('#dashboard-nav [data-page="project"]')
      await page.click('#project-list .row:first-child')
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await drawer()
      await page.waitForFunction(() => document.querySelector('[data-scope="all"]').disabled)
      assert.equal(await page.evaluate(() => document.querySelector('#session-scope-hint').hidden), false)
      assert.equal(await page.evaluate(() => document.querySelector('#session-overview').hidden), true)
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    throw error
  }
}
