import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 会话抽屉「本项目」与「全部」的一致性：同款组头、相同状态行、⋯ 与长按打开同一操作菜单。
// 只操作内存桥中的会话；真实多设备状态仍需 APK 验收。
export async function run({ spaceId, finish = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-session-parity')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode session parity 20261109')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const text = selector => page.evaluate(target => document.querySelector(target)?.textContent ?? '', selector)
  const settled = selector => page.waitForFunction(target => {
    const node = document.querySelector(target)
    return node.open && !node.getAnimations().some(animation => animation.playState === 'running')
  }, selector)
  const scope = async value => {
    await page.click(`[data-scope="${value}"]`)
    await page.waitForFunction(all => document.querySelector('#session-options').hidden === all, value === 'all')
  }
  const statusOf = (root, id) => text(`${root} [data-id="${id}"] small`)
  const closeSheet = async id => {
    await page.evaluate(target => document.getElementById(target).close(), id)
    await page.waitForFunction(target => !document.getElementById(target).open, id)
  }
  const touchHold = async (selector, ms) => {
    const point = await page.evaluate(target => {
      const box = document.querySelector(target).getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }, selector)
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await page.waitForTimeout(ms)
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
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
    await page.click('#project-list > :first-child .project-row:first-child .row')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    const seeded = await page.evaluate(() => {
      const fixture = window.__mobileFixture
      fixture.setTitle('mobile-1', 'Claude Code')
      return {
        tablet: fixture.addSession({ project: 'p-local', title: '平板任务', deviceName: 'Galaxy Tab', ownDevice: false }),
        remote: fixture.addSession({ project: 'p-ssh', title: '部署 api' }),
        remoteTwo: fixture.addSession({ project: 'p-ssh', title: '构建 web' }),
        desktop: fixture.addDesktopTerminal({ id: 'desktop-1', project: 'p-local', title: 'PowerShell' }).id,
      }
    })
    await page.click('#show-sessions')
    await settled('#session-drawer')
    // 首次打开要等能力确认后的一轮全量刷新，创建设备才会出现。
    await page.waitForFunction(id => document.querySelector(`#session-options [data-id="${id}"] small`)?.textContent.includes('来自 Galaxy Tab'), seeded.tablet)

    await step('the project scope uses the same group head with new and project actions', async () => {
      assert.equal(await text('#drawer-project-name'), 'QingCode')
      assert.equal(await text('#drawer-project-count'), '2')
      const head = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect()
        return { height: box('#drawer-project-head').height, add: box('#drawer-new-session').width, more: box('#drawer-project-more').width, sort: box('.drawer-sort').width }
      })
      assert.deepEqual([head.add, head.more, head.sort], [40, 40, 40])
      assert.ok(head.height <= 44, JSON.stringify(head))
      await page.screenshot({ path: resolve(output, 'project-390.png') })
      await page.click('#drawer-project-more')
      await page.waitForSelector('#project-actions-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#project-action-switch').hidden), true)
      await closeSheet('project-actions-dialog')
    })

    await step('both scopes show the same status line for the same session', async () => {
      const inProject = await statusOf('#session-options', seeded.tablet)
      assert.match(inProject, /来自 Galaxy Tab/)
      await scope('all')
      await page.waitForFunction(id => !!document.querySelector(`#session-overview [data-id="${id}"]`), seeded.tablet)
      assert.equal(await statusOf('#session-overview', seeded.tablet), inProject)
      assert.equal(await statusOf('#session-overview', 'mobile-1'), await page.evaluate(() => document.querySelector('#session-options [data-id="mobile-1"] small').textContent))
      assert.equal(await page.evaluate(() => document.querySelector('#drawer-project-head').hidden), true)
      await page.screenshot({ path: resolve(output, 'all-390.png') })
    })

    await step('all-scope rows pin and rename sessions of another project', async () => {
      const row = `#session-overview [data-id="${seeded.remote}"]`
      await page.click(row + ' .session-more')
      await page.waitForSelector('#session-actions-dialog[open]')
      assert.match(await text('#session-actions-context'), /api-server/)
      await page.click('#session-action-pin')
      await page.waitForFunction(selector => document.querySelector(selector).dataset.pinned === 'true', row)
      assert.match(await statusOf('#session-overview', seeded.remote), /^已置顶/)
      assert.equal(await page.evaluate(id => document.querySelector(`#session-overview [data-project="p-ssh"] .session-option`).dataset.id, seeded.remote), seeded.remote)
      await page.click(row + ' .session-more')
      await page.waitForSelector('#session-actions-dialog[open]')
      await page.click('#session-action-rename')
      await page.waitForSelector('#rename-session-dialog[open]')
      await page.fill('#session-name-input', '上线任务')
      await page.click('#save-session-name')
      await page.waitForFunction(selector => document.querySelector(selector + ' .session-label').textContent === '上线任务', row)
    })

    await step('long press opens the actions in the all scope', async () => {
      await touchHold(`#session-overview [data-id="${seeded.remoteTwo}"] .row`, 800)
      await page.waitForSelector('#session-actions-dialog[open]')
      assert.equal(await text('#session-actions-title'), '构建 web')
      await closeSheet('session-actions-dialog')
    })

    await step('desktop terminals can only be ended from the actions', async () => {
      await page.click('#session-overview [data-id="desktop-1"] .session-more')
      await page.waitForSelector('#session-actions-dialog[open]')
      assert.deepEqual(await page.evaluate(() => ['pin', 'rename', 'end'].map(name => document.querySelector('#session-action-' + name).hidden)), [true, true, false])
      await closeSheet('session-actions-dialog')
    })

    await step('ending from the all-scope actions asks first and removes only that session', async () => {
      await page.click(`#session-overview [data-id="${seeded.remoteTwo}"] .session-more`)
      await page.waitForSelector('#session-actions-dialog[open]')
      await page.click('#session-action-end')
      await page.waitForSelector('#confirm-dialog[open]')
      await page.click('#confirm-action')
      await page.waitForFunction(id => !document.querySelector(`#session-overview [data-id="${id}"]`), seeded.remoteTwo)
      assert.ok(await page.evaluate(() => document.querySelector('#terminal-name').textContent.length > 0))
      assert.equal(await page.evaluate(() => document.querySelector('[aria-current="true"]').closest('.session-option').dataset.id), 'mobile-1')
    })

    await step('multi-select hides row actions', async () => {
      await page.click('#session-overview .overview-manage')
      await page.waitForFunction(() => document.querySelector('#session-overview').dataset.selecting === 'true')
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#session-overview .session-more')).display), 'none')
      await page.click('#session-overview .overview-manage')
      await page.waitForFunction(() => document.querySelector('#session-overview').dataset.selecting === 'false')
    })

    await step('320px keeps the head, rows and footer inside the drawer', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, mobile: true, deviceScaleFactor: 1 })
      await page.waitForFunction(() => innerWidth === 320)
      for (const value of ['all', 'project']) {
        if (value === 'project') await scope('project')
        const layout = await page.evaluate(() => {
          const drawer = document.querySelector('#session-drawer')
          const right = drawer.getBoundingClientRect().right
          const inside = [...drawer.querySelectorAll('.session-more, #drawer-new-session, #drawer-project-more, .session-group-more')]
            .filter(node => node.offsetParent).every(node => node.getBoundingClientRect().right <= right)
          return { inside, overflow: drawer.scrollWidth > drawer.clientWidth, page: document.documentElement.scrollWidth > innerWidth }
        })
        assert.deepEqual(layout, { inside: true, overflow: false, page: false })
        await page.screenshot({ path: resolve(output, `${value}-320.png`) })
      }
    })

    await step('removing the current project from the project scope closes its phone sessions', async () => {
      await page.click('#drawer-project-more')
      await page.waitForSelector('#project-actions-dialog[open]')
      await page.click('#project-action-remove')
      await page.waitForSelector('#confirm-dialog[open]')
      assert.match(await text('#confirm-text'), /同时关闭其中 2 个手机会话/)
      await page.click('#confirm-dialog [value="cancel"]')
      await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open)
      assert.equal(await text('#drawer-project-count'), '2')
    })

    await step('both scopes list a project in the same order', async () => {
      const ids = selector => page.evaluate(target => [...document.querySelectorAll(target)].map(node => node.dataset.id).filter(id => id !== 'desktop-1'), selector)
      assert.deepEqual(await ids('#session-options .session-option'), await ids('#session-overview [data-project="p-local"] .session-option'))
    })

    await step('opening the drawer on the all scope scrolls to the current session', async () => {
      await page.evaluate(() => { for (let i = 0; i < 14; i += 1) window.__mobileFixture.addSession({ project: 'p-local', title: '任务 ' + i }) })
      await scope('all')
      await page.waitForFunction(() => document.querySelectorAll('#session-overview [data-project="p-local"] .session-option').length >= 16)
      await page.click('[data-close="session-drawer"]')
      await page.waitForFunction(() => !document.querySelector('#session-drawer').open)
      await page.click('#show-sessions')
      await settled('#session-drawer')
      await page.waitForFunction(() => {
        const row = document.querySelector('#session-overview .row[aria-current="true"]').getBoundingClientRect()
        const list = document.querySelector('#session-overview .overview-groups').getBoundingClientRect()
        return row.height > 0 && row.top >= list.top - 1 && row.bottom <= list.bottom + 1
      })
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    throw error
  }
}
