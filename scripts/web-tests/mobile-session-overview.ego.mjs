import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 手机会话纵览：工作台首页「全部会话」与会话抽屉「全部」共用组件，含多选批量关闭。
// 只操作内存桥中的会话，不触碰电脑端真实进程；真实多项目 / 多设备仍需 APK 验收。
export async function run({ spaceId, finish = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-session-overview')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode session overview 20261107')
  const page = task.page('p1')
  console.log({ spaceId: task.spaceId })
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const home = '#home-session-overview'
  const drawerView = '#session-overview'
  const rowIds = root => page.evaluate(selector => [...document.querySelectorAll(selector + ' .session-option')].map(node => node.dataset.id), root)
  const groupIds = root => page.evaluate(selector => [...document.querySelectorAll(selector + ' .session-group')].map(node => node.dataset.project), root)
  // 首页整页滚动：点击前把目标滚到视口中间。
  const tap = async (selector, options) => {
    await page.evaluate(target => document.querySelector(target)?.scrollIntoView({ block: 'center' }), selector)
    await page.click(selector, options)
  }
  const fillIn = async (selector, value) => {
    await page.evaluate(target => document.querySelector(target)?.scrollIntoView({ block: 'center' }), selector)
    await page.fill(selector, value)
  }
  const text = selector => page.evaluate(target => document.querySelector(target)?.textContent ?? '', selector)
  const drawer = async () => {
    if (!await page.evaluate(() => document.querySelector('#session-drawer').open)) await page.click('#show-sessions')
    await page.waitForFunction(() => document.querySelector('#session-drawer').open
      && !document.querySelector('#session-drawer').getAnimations().some(animation => animation.playState === 'running'))
  }
  const confirm = async (accept = true) => {
    await page.waitForSelector('#confirm-dialog[open]')
    const message = await text('#confirm-text')
    await page.click(accept ? '#confirm-action' : '#confirm-dialog [value="cancel"]')
    await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open)
    return message
  }
  const pair = async () => {
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.evaluate(() => window.qingOrientation(false))
  }
  const openFirstProject = async () => {
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list .row:first-child')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
  }
  const goHome = async () => {
    await page.evaluate(() => { while (window.qingBack()) { /* 逐层关闭弹层并返回工作台首页 */ } })
    await page.waitForFunction(() => !document.querySelector('#home-screen').hidden)
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
    await pair()
    await openFirstProject()
    // mobile-1 在本机项目；其余为远端项目、其他手机与电脑端已移除项目中的会话，共 11 个，超过首页先显示的 8 个。
    await page.evaluate(() => {
      const fixture = window.__mobileFixture
      fixture.setTitle('mobile-1', 'Claude Code')
      fixture.addSession({ project: 'p-ssh', title: '部署 api' })
      fixture.addSession({ project: 'p-ssh', title: 'vim 配置', deviceName: 'Galaxy Tab', ownDevice: false, exit: { code: 0 } })
      fixture.addSession({ project: 'p-gone', title: '旧任务', exit: { code: 1 },
        projectInfo: { id: 'p-gone', name: 'legacy', path: '/legacy', kind: 'wsl', host: '' } })
      for (let i = 1; i <= 6; i += 1) fixture.addSession({ project: 'p-ssh', title: '构建 ' + i })
      fixture.addSession({ project: 'p-ssh', title: '平板会话', deviceName: 'Galaxy Tab', ownDevice: false })
    })

    const setHomeSessions = value => page.evaluate(next => {
      const select = document.querySelector('#home-sessions-setting')
      select.value = next
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)

    await step('home shows all sessions by default and the setting can hide it', async () => {
      await goHome()
      await page.waitForFunction(() => !document.querySelector('#home-sessions').hidden)
      assert.equal(await page.evaluate(() => document.querySelector('#home-sessions-setting').value), 'on')
      await setHomeSessions('off')
      assert.equal(await page.evaluate(() => document.querySelector('#home-sessions').hidden), true)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:home-sessions')), 'off')
      await setHomeSessions('on')
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:home-sessions')), null)
    })

    await step('home lists all sessions above recent projects, shows eight first and marks the last used session', async () => {
      await goHome()
      await page.waitForFunction(() => !document.querySelector('#home-sessions').hidden
        && document.querySelector('#home-session-count').textContent === '11')
      const order = await page.evaluate(() => [...document.querySelector('#home-screen').children]
        .filter(node => !node.hidden).map(node => node.id).filter(Boolean))
      assert.ok(order.indexOf('home-sessions') < order.indexOf('home-projects'), JSON.stringify(order))
      assert.equal((await rowIds(home)).length, 8)
      assert.equal(await text(home + ' .overview-more'), '展开全部（还有 3 个）')
      assert.deepEqual(await groupIds(home), ['p-local', 'p-ssh'])
      assert.equal(await text(home + ' [data-project="p-ssh"] .session-group-count'), '9', 'group header keeps the full count')
      assert.match(await text(home + ' [data-id="mobile-1"] small'), /上次使用/)
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), false)
      const last = (await page.evaluate(() => window.__mobileFixture.state.sessionRequests)).at(-1)
      assert.equal(last.project, undefined, 'home reads every project in one request')
      await page.screenshot({ path: resolve(output, 'home-390.png') })
      await tap(home + ' .overview-more')
      assert.equal((await rowIds(home)).length, 11)
      assert.deepEqual(await groupIds(home), ['p-local', 'p-ssh', 'p-gone'])
      await tap(home + ' .overview-more')
      assert.equal((await rowIds(home)).length, 8)
    })

    await step('home search and filters show every match without the eight-row limit', async () => {
      await fillIn(home + ' .overview-search', 'galaxy')
      assert.deepEqual(await rowIds(home), ['mobile-3', 'mobile-11'])
      await fillIn(home + ' .overview-search', '')
      await tap(home + ' [data-filter="live"]')
      assert.equal((await rowIds(home)).length, 9)
      await tap(home + ' [data-filter="all"]')
    })

    await step('running first is an opt-in option shared by home and the drawer', async () => {
      const firstInSsh = root => page.evaluate(selector => document.querySelector(selector + ' [data-project="p-ssh"] .session-option')?.dataset.id, root)
      await page.evaluate(() => window.__mobileFixture.setTitle('mobile-10', '⠋ 构建 6'))
      await new Promise(done => setTimeout(done, 600))
      assert.notEqual(await firstInSsh(home), 'mobile-10', 'default keeps desktop order')
      assert.equal(await page.evaluate(selector => document.querySelector(selector + ' .overview-sort').getAttribute('aria-pressed'), home), 'false')
      await tap(home + ' .overview-sort')
      await page.waitForFunction(selector => document.querySelector(selector + ' [data-project="p-ssh"] .session-option')?.dataset.id === 'mobile-10', home)
      assert.equal(await page.evaluate(selector => document.querySelector(selector + ' .overview-sort').getAttribute('aria-pressed'), home), 'true')
      assert.equal(await page.evaluate(() => { const toast = document.querySelector('#sort-toast'); return toast && !toast.hidden ? toast.textContent : '' }), '已按运行中优先排序')
      await page.screenshot({ path: resolve(output, 'home-running-first.png') })
      await tap(home + ' .overview-sort')
      await page.waitForFunction(selector => document.querySelector(selector + ' [data-project="p-ssh"] .session-option')?.dataset.id !== 'mobile-10', home)
      await page.evaluate(() => window.__mobileFixture.setTitle('mobile-10', '构建 6'))
    })

    await step('closing another device\'s running session names that device in the confirmation', async () => {
      await tap(home + ' .overview-more')
      await tap(home + ' [data-id="mobile-11"] .session-close')
      assert.match(await confirm(false), /api-server \/ 平板会话.*由 Galaxy Tab 创建/)
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.ends), [])
      await tap(home + ' .overview-more')
    })

    await step('batch mode selects ended sessions across projects and closes them in one confirmation', async () => {
      await tap(home + ' .overview-manage')
      const view = await page.evaluate(selector => ({
        bar: !document.querySelector(selector + ' .overview-select-bar').hidden,
        closes: [...document.querySelectorAll(selector + ' .session-close')].filter(node => node.offsetParent).length,
        rows: document.querySelectorAll(selector + ' .session-option').length,
      }), home)
      assert.deepEqual(view, { bar: true, closes: 0, rows: 11 })
      await tap(home + ' .overview-select-ended')
      assert.equal(await text(home + ' .overview-picked'), '已选 2')
      await page.screenshot({ path: resolve(output, 'home-batch.png') })
      await tap(home + ' .overview-end')
      const message = await confirm()
      assert.match(message, /将移除 2 个已结束会话的输出/)
      assert.match(message, /涉及 2 个项目/)
      await page.waitForFunction(() => document.querySelector('#home-session-count').textContent === '9')
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.ends), ['mobile-3', 'mobile-4'])
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.selecting, home), 'false', 'batch mode ends once nothing is left selected')
    })

    await step('batch confirmation counts other devices, cancel keeps the selection, select all toggles', async () => {
      await tap(home + ' .overview-manage')
      await tap(home + ' [data-id="mobile-11"] .row')
      await tap(home + ' [data-id="mobile-5"] .row')
      assert.equal(await text(home + ' .overview-picked'), '已选 2')
      await tap(home + ' .overview-end')
      const message = await confirm(false)
      assert.match(message, /将关闭 2 个运行中会话/)
      assert.match(message, /其中 1 个由其他设备创建/)
      assert.equal(await text(home + ' .overview-picked'), '已选 2')
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.ends), ['mobile-3', 'mobile-4'])
      await tap(home + ' .overview-select-all')
      assert.equal(await text(home + ' .overview-picked'), '已选 9')
      assert.equal(await text(home + ' .overview-select-all'), '取消全选')
      await tap(home + ' .overview-select-all')
      assert.equal(await text(home + ' .overview-picked'), '已选 0')
      await tap(home + ' .overview-manage')
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.selecting, home), 'false')
    })

    await step('tapping a session on home opens its project and session', async () => {
      await tap(home + ' [data-id="mobile-2"] .row', { label: 'open session from home' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中'
        && document.querySelector('#terminal-host').textContent.includes('api-server'))
      assert.equal(await text('#terminal-name'), '部署 api')
    })

    await step('the drawer keeps the same overview with current project first and batch close', async () => {
      await drawer()
      assert.equal(await page.evaluate(() => document.querySelector('[data-scope="project"]').getAttribute('aria-checked')), 'true')
      await page.click('[data-scope="all"]')
      await page.waitForFunction(selector => document.querySelectorAll(selector + ' .session-option').length === 9, drawerView)
      assert.deepEqual(await groupIds(drawerView), ['p-ssh', 'p-local'])
      assert.equal(await page.evaluate(selector => document.querySelector(selector + ' [data-current="true"]')?.dataset.id, drawerView), 'mobile-2')
      assert.match(await text('#session-context'), /2 个项目/)
      await tap(drawerView + ' .overview-manage')
      await tap(drawerView + ' [data-id="mobile-6"] .row')
      await tap(drawerView + ' [data-id="mobile-7"] .row')
      await tap(drawerView + ' .overview-end')
      assert.match(await confirm(), /关闭 2 个运行中会话/)
      await page.waitForFunction(selector => document.querySelectorAll(selector + ' .session-option').length === 7, drawerView)
      assert.equal(await text('#terminal-status'), '会话中')
      assert.equal(await text('#terminal-name'), '部署 api')
      await page.screenshot({ path: resolve(output, 'drawer-390.png') })
    })

    await step('narrow home and short landscape drawer keep 44px actions and at least one visible row', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, mobile: true, deviceScaleFactor: 1 })
      await page.evaluate(() => window.qingOrientation(true))
      await page.waitForFunction(() => innerWidth === 844)
      const drawerLayout = await page.evaluate(() => {
        const row = document.querySelector('#session-overview .session-option').getBoundingClientRect()
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          visible: row.bottom <= document.querySelector('.drawer-actions').getBoundingClientRect().top }
      })
      const sizes = await page.evaluate(() => Object.fromEntries(['.drawer-heading', '#session-scope', '#session-overview .overview-tools', '#session-overview .overview-filter', '#session-overview .session-group-head', '#session-overview .session-option', '.drawer-actions', '#session-context']
        .map(selector => { const box = document.querySelector(selector)?.getBoundingClientRect(); return [selector, box ? [Math.round(box.top), Math.round(box.height)] : null] })))
      assert.deepEqual(drawerLayout, { overflow: false, visible: true }, JSON.stringify(sizes))
      await page.screenshot({ path: resolve(output, 'drawer-844x390.png') })
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, mobile: true, deviceScaleFactor: 1 })
      await page.evaluate(() => window.qingOrientation(false))
      await page.waitForFunction(() => innerWidth === 320)
      await goHome()
      await page.waitForFunction(() => !document.querySelector('#home-sessions').hidden)
      await tap(home + ' .overview-manage')
      const homeLayout = await page.evaluate(selector => {
        const root = document.querySelector(selector)
        const actions = [...root.querySelectorAll('.overview-manage, .overview-select-bar button')].map(node => node.getBoundingClientRect())
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          inside: actions.every(box => box.right <= innerWidth + 0.5 && box.height >= 40) }
      }, home)
      assert.deepEqual(homeLayout, { overflow: false, inside: true })
      await page.screenshot({ path: resolve(output, 'home-320-batch.png') })
      await tap(home + ' .overview-manage')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 })
    })

    await step('old desktops without all_sessions hide the home section and disable the drawer scope', async () => {
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
      await pair()
      await openFirstProject()
      await page.evaluate(() => window.__mobileFixture.addSession({ project: 'p-ssh', title: '部署 api' }))
      await drawer()
      await page.waitForFunction(() => document.querySelector('[data-scope="all"]').disabled)
      assert.equal(await page.evaluate(() => document.querySelector('#session-scope-hint').hidden), false)
      await goHome()
      await new Promise(done => setTimeout(done, 600))
      assert.equal(await page.evaluate(() => document.querySelector('#home-sessions').hidden), true)
      assert.ok((await page.evaluate(() => window.__mobileFixture.state.sessionRequests)).every(item => item.project !== undefined))
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
