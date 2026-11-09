import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 平板侧栏「全部」范围：切换项目不跳动不黑屏、项目常驻与手动移除、组头新建、折叠、有新结果、项目和终端拖动排序。
 * 真实 Web 资产 + 内存桥；触摸经 CDP 发出，不替代 Android 真机手感与 WebGL 画面验收。
 */
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', finish = true } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-tablet-projects')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile tablet projects 20261109')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const view = '#session-overview'
  const group = id => `${view} .session-group[data-project="${id}"]`
  const row = id => `${view} .session-option[data-id="${id}"]`
  const groupIds = () => page.evaluate(selector => [...document.querySelectorAll(selector + ' .session-group')].map(node => node.dataset.project), view)
  const rowIds = id => page.evaluate(selector => [...document.querySelectorAll(selector + ' .session-option')].map(node => node.dataset.id), group(id))
  const text = selector => page.evaluate(target => document.querySelector(target)?.textContent ?? '', selector)
  const click = selector => page.evaluate(target => document.querySelector(target).click(), selector)
  const stored = key => page.evaluate(name => JSON.parse(Object.entries(localStorage).find(([item]) => item.includes(name))?.[1] ?? '[]'), key)
  const ready = host => page.waitForFunction(name => document.querySelector('#terminal-status').textContent === '会话中'
    && document.querySelector('#terminal-host').textContent.includes(name)
    && !document.querySelector('.terminal-held-frame'), host)
  const confirm = async () => {
    await page.waitForSelector('#confirm-dialog[open]')
    const message = await text('#confirm-text')
    await click('#confirm-action')
    await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open)
    return message
  }
  const center = selector => page.evaluate(target => {
    const box = document.querySelector(target).getBoundingClientRect()
    return { x: box.left + Math.min(box.width / 2, 60), y: box.top + box.height / 2 }
  }, selector)
  const touch = (type, point) => page.cdp('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] })
  /** 长按 hold 毫秒后移动到 to（不给 to 时原地松手）。 */
  const longPress = async (selector, to, hold = 420) => {
    const from = await center(selector)
    await touch('touchStart', from)
    await page.waitForTimeout(hold)
    if (to) {
      const target = await center(to)
      for (let i = 1; i <= 6; i += 1) {
        await touch('touchMove', { x: from.x, y: from.y + (target.y - from.y) * i / 6 })
        await page.waitForTimeout(16)
      }
    }
    await touch('touchEnd')
  }
  // 切换期间逐次变化记录分组顺序、禁用行和终端节点数，断言中间态没有跳动、变暗和黑屏。
  const startWatch = () => page.evaluate(selector => {
    const samples = []
    const sample = () => samples.push({
      groups: [...document.querySelectorAll(selector + ' .session-group')].map(node => node.dataset.project).join(),
      disabled: document.querySelectorAll(selector + ' .row:disabled').length,
      terminals: document.querySelectorAll('#viewport .xterm').length,
      held: document.querySelectorAll('#viewport .terminal-held-frame').length,
    })
    const observer = new MutationObserver(sample)
    observer.observe(document.querySelector('#session-drawer'), { subtree: true, childList: true, attributes: true })
    observer.observe(document.querySelector('#viewport'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    window.__switchWatch = { samples, stop: () => observer.disconnect() }
  }, view)
  const stopWatch = () => page.evaluate(() => { window.__switchWatch.stop(); return window.__switchWatch.samples })

  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, screenWidth: 1280, screenHeight: 800, deviceScaleFactor: 1, mobile: true })
    await page.goto(baseUrl + '/mobile-android/', { timeout: 60000 })
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => {
      window.__mobileFixture.state.projects.push({ id: 'p-third', name: 'django', path: '/srv/django', kind: 'wsl', host: '' })
      window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764, undefined, '工作电脑'))
    })
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]')
    await page.click('#project-list > :first-child .project-row:first-child .row')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    const ids = await page.evaluate(() => {
      const fixture = window.__mobileFixture
      return { api: fixture.addSession({ project: 'p-ssh', title: '部署 api' }), web: fixture.addSession({ project: 'p-third', title: '测试 web' }),
        extra: fixture.addSession({ project: 'p-third', title: '拉取代码' }) }
    })
    await click('#show-sessions')
    await page.waitForFunction(() => document.querySelector('#session-drawer').open && document.querySelector('#session-drawer').dataset.docked === 'true')
    await click('[data-scope="all"]')
    await page.waitForFunction(selector => document.querySelectorAll(selector + ' .session-group').length === 3, view)

    await step('switching projects never reorders groups, dims rows or blanks the terminal', async () => {
      const before = await groupIds()
      assert.equal(before[0], 'p-local', 'the project opened first keeps its position')
      await page.evaluate(() => window.scrollTo(0, 0))
      await startWatch()
      for (const [id, host] of [[ids.web, 'django'], [ids.api, 'api-server'], [ids.web, 'django']]) {
        await click(row(id) + ' .row')
        await ready(host)
        assert.deepEqual(await groupIds(), before)
      }
      await page.waitForFunction(() => document.querySelectorAll('#viewport .xterm').length === 1)
      const samples = await stopWatch()
      assert.ok(samples.length > 3, 'watch recorded the switches')
      assert.deepEqual([...new Set(samples.map(item => item.groups))], [before.join()], 'group order and membership stay stable')
      assert.equal(Math.max(...samples.map(item => item.disabled)), 0, 'rows are never dimmed while switching')
      assert.ok(Math.min(...samples.map(item => item.terminals)) >= 1, 'the terminal area is never empty')
      assert.ok(samples.some(item => item.held === 1), 'the previous frame stays until the new one is ready')
    })
    await page.screenshot({ path: resolve(output, 'switched.png') })

    await step('closing the last terminal keeps the project and stays on it', async () => {
      await click(row(ids.api) + ' .row')
      await ready('api-server')
      await click(row(ids.api) + ' .session-close')
      await confirm()
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '暂无终端' && !document.querySelector('#terminal-empty').hidden)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-screen').hidden), false)
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), true)
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.empty, group('p-ssh')), 'true')
      assert.equal(await text(group('p-ssh') + ' .session-group-count'), '0')
    })
    await page.screenshot({ path: resolve(output, 'empty-project.png') })

    await step('the project header creates a terminal in another project without visiting it first', async () => {
      await click(group('p-local') + ' .session-group-add')
      await page.waitForSelector('#new-session-dialog[open]')
      assert.match(await text('#new-session-context'), /QingCode/)
      await page.waitForFunction(() => document.querySelector('#terminal-profiles').getAttribute('aria-busy') === 'false')
      await click('#terminal-profiles button[data-profile="claude"]')
      await ready('QingCode')
      const created = await page.evaluate(() => window.__mobileFixture.state.creates.at(-1))
      assert.deepEqual(created, { project: 'p-local', terminalProfile: 'claude' })
      assert.equal(await page.evaluate(() => document.querySelector('#new-session-dialog').open), false)
    })

    await step('the project menu switches to a project without terminals', async () => {
      await click(group('p-ssh') + ' .session-group-more')
      await page.waitForSelector('#project-actions-dialog[open]')
      assert.equal(await text('#project-actions-title'), 'api-server')
      assert.equal(await page.evaluate(() => document.querySelector('#project-action-switch').hidden), false)
      await click('#project-action-switch')
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '暂无终端'
        && document.querySelector('#terminal-host').textContent.includes('api-server'))
    })

    await step('collapse hides rows, survives re-render, and empty projects cannot collapse', async () => {
      await click(group('p-third') + ' .session-group-toggle')
      await page.waitForFunction(selector => document.querySelector(selector).hidden, group('p-third') + ' .session-group-rows')
      assert.deepEqual(await stored('session-groups-collapsed'), ['p-third'])
      assert.equal(await page.evaluate(selector => document.querySelector(selector).hasAttribute('aria-expanded'), group('p-ssh') + ' .session-group-toggle'), false)
      await click(group('p-ssh') + ' .session-group-toggle')
      assert.deepEqual(await stored('session-groups-collapsed'), ['p-third'])
    })

    await step('a background terminal that finishes is marked until it is viewed, also on a collapsed header', async () => {
      const busy = value => page.evaluate(([id, on]) => {
        const session = window.__mobileFixture.state.sessions.get(id)
        session.programBusy = on
        session.activityRevision = (session.activityRevision ?? 0) + 1
      }, [ids.web, value])
      await busy(true)
      await page.waitForFunction(selector => document.querySelector(selector).dataset.running === 'true', row(ids.web), { timeout: 8000 })
      await busy(false)
      await page.waitForFunction(selector => document.querySelector(selector).dataset.attention === 'true', group('p-third'), { timeout: 8000 })
      await page.screenshot({ path: resolve(output, 'attention-collapsed.png') })
      await click(group('p-third') + ' .session-group-toggle')
      assert.match(await text(row(ids.web) + ' small'), /有新结果/)
      await click(row(ids.web) + ' .row')
      await ready('django')
      await page.waitForFunction(selector => document.querySelector(selector).dataset.attention === 'false', row(ids.web))
      assert.doesNotMatch(await text(row(ids.web) + ' small'), /有新结果/)
    })

    await step('long-press dragging reorders projects and persists', async () => {
      const before = await groupIds()
      await longPress(group(before[0]) + ' .session-group-toggle', group(before[2]))
      await page.waitForFunction(first => document.querySelector('#session-overview .session-group').dataset.project !== first, before[0])
      const after = await groupIds()
      assert.equal(after.at(-1), before[0])
      assert.deepEqual(await stored('sidebar-projects'), after)
    })
    await page.screenshot({ path: resolve(output, 'reordered.png') })

    await step('long-press dragging reorders terminals inside a project; holding still opens the action menu', async () => {
      const before = await rowIds('p-third')
      assert.equal(before.length, 2)
      await longPress(row(before[0]) + ' .row', row(before[1]) + ' .row')
      await page.waitForFunction(([selector, first]) => document.querySelector(selector + ' .session-option').dataset.id !== first, [group('p-third'), before[0]])
      assert.deepEqual(await rowIds('p-third'), [before[1], before[0]])
      assert.deepEqual((await stored('session-order')).slice(0, 2), [before[1], before[0]])
      await longPress(row(before[0]) + ' .row')
      await page.waitForSelector('#session-actions-dialog[open]')
      await page.evaluate(() => document.querySelector('#session-actions-dialog').close())
    })

    await step('the same order applies in this-project scope and holding still opens the action menu', async () => {
      const order = await rowIds('p-third')
      await click('[data-scope="project"]')
      await page.waitForFunction(() => !document.querySelector('#session-options').hidden)
      await page.waitForFunction(() => document.querySelectorAll('#session-options .session-option').length === 2)
      const list = () => page.evaluate(() => [...document.querySelectorAll('#session-options .session-option')].map(node => node.dataset.id))
      assert.deepEqual(await list(), order)
      await longPress(`#session-options .session-option[data-id="${order[0]}"] .row`)
      await page.waitForSelector('#session-actions-dialog[open]')
      await click('#session-actions-dialog [data-close="session-actions-dialog"]')
      await page.waitForFunction(() => !document.querySelector('#session-actions-dialog').open)
      await click('[data-scope="all"]')
      await page.waitForFunction(selector => !document.querySelector(selector).hidden, view)
    })

    await step('removing a project closes its phone sessions, keeps desktop terminals listed and is not undone by refresh', async () => {
      await page.evaluate(() => window.__mobileFixture.addDesktopTerminal({ id: 'desk-1', project: 'p-local', title: '电脑终端' }))
      await page.waitForFunction(selector => !!document.querySelector(selector), row('desk-1'), { timeout: 8000 })
      await click(group('p-local') + ' .session-group-more')
      await page.waitForSelector('#project-actions-dialog[open]')
      await click('#project-action-remove')
      const message = await confirm()
      assert.match(message, /电脑端的项目和文件不受影响/)
      assert.match(message, /同时关闭其中 2 个手机会话/)
      assert.match(message, /电脑上开的 1 个终端不受影响/)
      await page.waitForFunction(() => !JSON.parse(localStorage.getItem('qingcode:mobile:sidebar-projects:' + Object.keys(localStorage).find(key => key.startsWith('qingcode:mobile:sidebar-projects:')).split('sidebar-projects:')[1])).includes('p-local'))
      const sessions = await page.evaluate(() => [...window.__mobileFixture.state.sessions.values()].filter(item => item.project === 'p-local').map(item => item.id))
      assert.deepEqual(sessions, ['desk-1'])
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.draggable, group('p-local')), 'false')
      assert.ok(await page.evaluate(() => window.__mobileFixture.state.projects.some(item => item.id === 'p-local')), 'desktop project list is untouched')
      await page.waitForTimeout(3500)
      assert.ok(!(await stored('sidebar-projects')).includes('p-local'), 'a later refresh must not re-add the removed project')
      await page.evaluate(() => window.__mobileFixture.state.sessions.delete('desk-1'))
      await page.waitForFunction(selector => !document.querySelector(selector), group('p-local'), { timeout: 8000 })
    })

    await step('removing the current project moves to the next one and never to an empty sidebar', async () => {
      const current = await page.evaluate(selector => document.querySelector(selector + ' .session-group[data-current-project="true"]').dataset.project, view)
      await click(group(current) + ' .session-group-more')
      await page.waitForSelector('#project-actions-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('#project-action-switch').hidden), true, 'switching to the current project is pointless')
      await click('#project-action-remove')
      await confirm()
      await page.waitForFunction(id => !document.querySelector(`#session-overview .session-group[data-project="${id}"]`)
        && document.querySelector('#session-overview .session-group[data-current-project="true"]'), current)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-screen').hidden), false)
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), true)
    })
    await page.screenshot({ path: resolve(output, 'after-remove.png') })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results, error: String(error) })
    throw error
  }
}
