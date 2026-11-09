// 手机端界面精简验收：按键图标对齐、底栏不占状态行、左滑关闭、开关、项目分组、弹层不抢焦点。
// 使用真实 Web 资产和内存桥；触摸经 CDP 发出，不替代 Android 真机手感验收。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439' } = {}) {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/mobile-ui-polish')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile UI polish 20261108')
  const page = task.page('p1')
  console.log({ spaceId: task.spaceId })
  const results = []
  const shots = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const shot = async name => {
    try { await page.screenshot({ path: resolve(output, name) }); shots.push(name) } catch (error) { shots.push(name + ' (skipped: ' + error.name + ')') }
  }
  const metrics = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
  const settled = id => page.waitForFunction(value => !document.getElementById(value).getAnimations().some(animation => animation.playState === 'running'), id)
  const touch = (type, x, y) => page.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
  const swipeLeft = async (selector, distance) => {
    const box = await page.evaluate(target => {
      const rect = document.querySelector(target).getBoundingClientRect()
      return { x: rect.right - 40, y: rect.top + rect.height / 2 }
    }, selector)
    await touch('touchStart', box.x, box.y)
    for (let moved = 12; moved <= distance; moved += 12) await touch('touchMove', box.x - moved, box.y)
    await touch('touchEnd')
    await page.waitForTimeout(260)
  }
  try {
    await metrics(390, 844)
    await page.goto(baseUrl + '/mobile-android/?lang=zh')
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
    await page.reload()
    await metrics(390, 844)
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.evaluate(() => window.qingOrientation(false))

    await step('项目按主机分组，可折叠，搜索时自动展开', async () => {
      await page.click('#dashboard-nav [data-page="project"]')
      await page.waitForFunction(() => document.querySelectorAll('#project-list .project-group').length > 1)
      const first = '#project-list .project-group:first-child'
      await page.click(first + ' .project-group-head')
      assert.equal(await page.evaluate(selector => document.querySelector(selector + ' .rows').hidden, first), true)
      await page.fill('#search', 'qingcode')
      await page.waitForFunction(() => document.querySelectorAll('#project-list .row').length > 0 && [...document.querySelectorAll('#project-list .rows')].every(rows => !rows.hidden))
      await page.fill('#search', '')
      await page.waitForFunction(selector => document.querySelector(selector + ' .rows').hidden, first)
      await page.click(first + ' .project-group-head')
      await shot('projects.png')
    })

    await step('搜索图标在不同输入框高度下都与输入框垂直居中', async () => {
      // 真机输入框会比样式 min-height 略高，这里用 46px 复现，防止回到固定 top。
      const offset = selector => page.evaluate(target => {
        const field = document.querySelector(target)
        const tools = field.closest('.overview-tools')
        const hidden = [field.hidden, tools?.hidden]
        field.hidden = false
        if (tools) tools.hidden = false
        const input = field.querySelector('input')
        input.style.minHeight = '46px'
        const center = element => { const box = element.getBoundingClientRect(); return box.top + box.height / 2 }
        const result = Math.abs(center(field.querySelector(':scope > svg')) - center(input))
        input.style.minHeight = ''
        field.hidden = hidden[0]
        if (tools) tools.hidden = hidden[1]
        return result
      }, selector)
      assert.ok(await offset('#project-screen .search-field') <= 0.5)
      await page.click('#dashboard-nav [data-page="home"]')
      await page.waitForSelector('.session-overview .search-field', { state: 'attached' }).catch(() => {})
      assert.ok(await offset('.session-overview .search-field') <= 0.5)
      await shot('home-search.png')
      await page.click('#dashboard-nav [data-page="project"]')
    })

    await step('项目行左滑复制显示路径，复制后收起且不打开项目', async () => {
      const row = '#project-list .project-group:nth-child(2) .project-row'
      await swipeLeft(row + ' .project-face', 90)
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.revealed, row), 'true')
      await shot('project-swipe.png')
      await page.click(row + ' .project-copy')
      await page.waitForFunction(() => window.__mobileFixture.state.clipboard === '/srv/api')
      await page.waitForFunction(selector => document.querySelector(selector).dataset.revealed === undefined, row)
      assert.match(await page.evaluate(() => document.querySelector('#sort-toast').textContent), /已复制路径/)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-screen').hidden), true)
    })

    await step('下拉刷新浮标不推动列表，越过阈值后显示结果并收起', async () => {
      const top = () => page.evaluate(() => document.querySelector('#project-filters').getBoundingClientRect().top)
      const state = () => page.evaluate(() => document.querySelector('#project-pull').dataset.state)
      const before = await top()
      const x = 195
      await touch('touchStart', x, 200)
      for (let y = 212; y <= 440; y += 12) await touch('touchMove', x, y)
      assert.equal(await state(), 'ready')
      assert.equal(await top(), before)
      assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('#project-pull .pull-badge')).opacity === '1'))
      await shot('pull-ready.png')
      await touch('touchEnd')
      await page.waitForFunction(() => document.querySelector('#project-pull').dataset.state === 'done')
      await shot('pull-done.png')
      await page.waitForFunction(() => document.querySelector('#project-pull').dataset.state === undefined)
      assert.equal(await top(), before)
    })

    await step('连接页支持下拉刷新，当前电脑卡片没有左缘色条', async () => {
      await page.click('#dashboard-nav [data-page="connection"]')
      const state = () => page.evaluate(() => document.querySelector('#connection-pull').dataset.state)
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.connection-card[data-current="true"]')).boxShadow), 'none')
      const x = 195
      await touch('touchStart', x, 300)
      for (let y = 312; y <= 540; y += 12) await touch('touchMove', x, y)
      assert.equal(await state(), 'ready')
      await shot('connection-pull-ready.png')
      await touch('touchEnd')
      await page.waitForFunction(() => document.querySelector('#connection-pull').dataset.state === 'done')
      await page.waitForFunction(() => document.querySelector('#connection-pull').dataset.state === undefined)
      await shot('connection-no-rail.png')
      // 失败态直接置状态，只验收图标呈现；失败流程由内存桥之外的真机覆盖。
      await page.evaluate(() => {
        const indicator = document.querySelector('#connection-pull')
        indicator.dataset.state = 'failed'
        indicator.style.setProperty('--pull', '76px')
        indicator.style.setProperty('--pull-progress', '1')
      })
      assert.deepEqual(await page.evaluate(() => {
        const icon = document.querySelector('#connection-pull .pull-failed')
        return { display: getComputedStyle(icon).display, href: icon.querySelector('use').getAttribute('href') }
      }), { display: 'block', href: '#i-alert' })
      await page.waitForTimeout(260)
      await shot('connection-pull-failed.png')
      await page.evaluate(() => {
        const indicator = document.querySelector('#connection-pull')
        delete indicator.dataset.state
        indicator.style.setProperty('--pull', '0px')
        indicator.style.setProperty('--pull-progress', '0')
      })
      await page.click('#dashboard-nav [data-page="project"]')
    })

    await page.click('#project-list > :first-child .project-row:first-child .row')
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')

    await step('方向键和退格是 SVG，图标在按键内水平垂直居中', async () => {
      const offsets = await page.evaluate(() => ['up', 'down', 'backspace', 'left', 'right'].map(key => {
        const button = document.querySelector(`#special-keys [data-key="${key}"]`)
        const glyph = button.querySelector('svg')
        const a = button.getBoundingClientRect()
        const b = glyph.getBoundingClientRect()
        return { key, text: button.textContent.trim(), x: Math.abs((a.left + a.right - b.left - b.right) / 2), y: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) }
      }))
      for (const item of offsets) {
        assert.equal(item.text, '', item.key)
        assert.ok(item.x <= 0.5 && item.y <= 0.5, JSON.stringify(item))
      }
    })

    await step('390px 下七个常用键完整可见，底栏只有两排', async () => {
      await page.evaluate(() => document.querySelector('#input-tip-dismiss').click())
      await page.waitForFunction(() => document.querySelector('#input-tip').hidden)
      const layout = await page.evaluate(() => {
        const more = document.querySelector('#more-keys').getBoundingClientRect()
        const backspace = document.querySelector('[data-key="backspace"]').getBoundingClientRect()
        const keys = document.querySelector('#special-keys').getBoundingClientRect()
        const compose = document.querySelector('#compose-form').getBoundingClientRect()
        return { gap: more.left - backspace.right, stacked: keys.bottom <= compose.top, stateHidden: document.querySelector('.terminal-state').hidden, tools: document.querySelector('#terminal-tools').getBoundingClientRect().height }
      })
      assert.ok(layout.gap >= -1, JSON.stringify(layout))
      assert.ok(layout.stacked && layout.stateHidden)
      assert.ok(layout.tools <= 130, JSON.stringify(layout))
      await shot('terminal.png')
    })

    await step('状态提示浮在终端上，显隐不改变终端行列', async () => {
      const rows = () => page.evaluate(() => document.querySelector('#viewport').getBoundingClientRect().height)
      const before = await rows()
      await page.evaluate(() => { document.querySelector('#terminal-status').textContent = '连接中断，正在重试' })
      await page.waitForFunction(() => !document.querySelector('.terminal-state').hidden)
      assert.equal(await rows(), before)
      await shot('terminal-status.png')
      await page.evaluate(() => { document.querySelector('#terminal-status').textContent = '会话中' })
      await page.waitForFunction(() => document.querySelector('.terminal-state').hidden)
    })

    await step('收起按键后展开按钮移到输入框左侧，不多占一行', async () => {
      await page.click('#toggle-keys')
      await page.waitForFunction(() => document.querySelector('#special-keys').hidden)
      const placed = await page.evaluate(() => {
        const toggle = document.querySelector('#toggle-keys').getBoundingClientRect()
        const compose = document.querySelector('#compose-form').getBoundingClientRect()
        return toggle.right <= compose.left && toggle.top >= compose.top - 1 && toggle.bottom <= compose.bottom + 1
      })
      assert.ok(placed)
      await page.click('#toggle-keys')
      await page.waitForFunction(() => !document.querySelector('#special-keys').hidden)
    })

    await step('左滑露出关闭按钮，点行面收起且不切换会话', async () => {
      await page.evaluate(() => window.__mobileFixture.addSession({ project: 'p-local', title: '✳ 第二个会话' }))
      await page.click('#show-sessions')
      await page.waitForSelector('#session-drawer[open]')
      await settled('session-drawer')
      await page.waitForFunction(() => document.querySelectorAll('#session-options .session-option').length === 2)
      const row = '#session-options .session-option[data-current="false"]'
      assert.equal(await page.evaluate(selector => document.querySelector(selector + ' .session-label').textContent, row), '第二个会话')
      await swipeLeft(row + ' .session-face', 90)
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.revealed, row), 'true')
      await shot('drawer-swipe.png')
      const selected = await page.evaluate(() => document.querySelector('#session-options [data-current="true"]').dataset.id)
      await page.evaluate(selector => document.querySelector(selector + ' .row').click(), row)
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.revealed, row), undefined)
      assert.equal(await page.evaluate(() => document.querySelector('#session-options [data-current="true"]').dataset.id), selected)
      await swipeLeft(row + ' .session-face', 20)
      assert.equal(await page.evaluate(selector => document.querySelector(selector).dataset.revealed, row), undefined)
      await page.evaluate(() => window.qingBack())
    })

    await step('打开弹层时焦点不落在控件上，连接详情不弹键盘', async () => {
      const active = () => page.evaluate(() => document.activeElement.tagName + ':' + (document.activeElement.id || ''))
      await page.click('#terminal-menu')
      await page.waitForSelector('#terminal-menu-dialog[open]')
      assert.equal(await active(), 'H2:terminal-menu-title')
      await page.evaluate(() => window.qingBack())
      await page.evaluate(() => { while (window.qingBack()) { /* 回到工作台 */ } })
      await page.click('#dashboard-nav [data-page="connection"]')
      await page.click('#connection-list .icon-button')
      await page.waitForSelector('#host-dialog[open]')
      assert.equal(await active(), 'H2:host-title')
      assert.equal(await page.evaluate(() => document.querySelector('#host-advanced').open), false)
      await shot('host-detail.png')
      await page.evaluate(() => window.qingBack())
    })

    await step('二选一设置是开关，整行可点，写回 select 并保存', async () => {
      await page.click('#open-settings')
      await page.waitForSelector('#settings-dialog[open]')
      await settled('settings-dialog')
      const toggle = '#keep-screen-on ~ .switch'
      assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-checked'), toggle), 'false')
      await page.evaluate(selector => document.querySelector(selector).closest('.setting-row').querySelector('label').click(), toggle)
      await page.waitForFunction(selector => document.querySelector(selector).getAttribute('aria-checked') === 'true', toggle)
      assert.equal(await page.evaluate(() => document.querySelector('#keep-screen-on').value), 'on')
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:keep-screen-on')), 'on')
      assert.equal(await page.evaluate(() => document.querySelector('#settings-dialog').getBoundingClientRect().width), 390)
      await shot('settings.png')
      await page.evaluate(selector => document.querySelector(selector).click(), toggle)
      assert.equal(await page.evaluate(() => document.querySelector('#keep-screen-on').value), 'off')
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, results, shots }, null, 2))
    await task.finish({ keep: [] })
    console.log(JSON.stringify({ output, results, shots }, null, 2))
  } catch (error) {
    results.push({ passed: false, error: String(error?.stack ?? error) })
    await shot('failure.png')
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ nativeIntegration: false, spaceId: task.spaceId, results, shots }, null, 2))
    console.log(JSON.stringify({ output, results, shots }, null, 2))
    throw error
  }
}
