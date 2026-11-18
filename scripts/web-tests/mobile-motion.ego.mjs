// 安卓界面动效 Web 验收：弹层退出、按压回弹、页面与浮层入场、虚拟鼠标入场、发送回执、
// 延迟探测闪烁、会话行收起、页面按导航方向滑入与分区依次上浮、导航指示块展开、列表行柔和按下态、
// 进入终端时标题原位上浮、全屏工作页关闭不变形、应用内减少动效，以及减少动画时全部关闭；顺带检查会话行图标与标题对齐。
// 使用内存桥，动画是否流畅仍需真机确认。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-motion')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile motion 20261106')
  console.log({ spaceId: task.spaceId })
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const started = () => page.evaluate(() => window.__started.splice(0))
  /** 合成输入在自动化窗口里不一定进入 :active，这里直接强制伪类，只验证样式。 */
  const press = async (selector, read) => {
    await page.cdp('DOM.enable')
    await page.cdp('CSS.enable')
    const { root } = await page.cdp('DOM.getDocument')
    const { nodeId } = await page.cdp('DOM.querySelector', { nodeId: root.nodeId, selector })
    await page.cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] })
    // 窗口被节流时过渡时间不走，读一次样式启动过渡后直接跳到终点。
    await page.evaluate(read, selector)
    await page.evaluate(selector => { for (const animation of document.querySelector(selector).getAnimations()) animation.finish() }, selector)
    const value = await page.evaluate(read, selector)
    await page.cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    return value
  }
  const scaleOf = selector => { const match = /matrix\(([^,]+)/.exec(getComputedStyle(document.querySelector(selector)).transform); return match ? Number(match[1]) : 1 }
  /** 同步关闭弹层并立刻读取退出状态。 */
  const closing = id => page.evaluate(id => {
    const dialog = document.getElementById(id)
    const rect = dialog.getBoundingClientRect()
    dialog.close('cancel')
    const style = getComputedStyle(dialog)
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      open: dialog.open,
      display: style.display,
      pointerEvents: style.pointerEvents,
      hitsDialog: dialog.contains(hit),
      properties: dialog.getAnimations().map(animation => animation.transitionProperty),
    }
  }, id)
  const gone = id => page.waitForFunction(id => getComputedStyle(document.getElementById(id)).display === 'none', id)

  try {
    // 测试机系统可能开着「减少动画」，这里固定为默认偏好，最后一步再单独验证减少动画。
    await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await page.goto(baseUrl + '/mobile-android/?lang=zh', { timeout: 60000 })
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:') && key !== 'qingcode:mobile:locale') localStorage.removeItem(key)
    })
    await page.reload()
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => {
      window.__started = []
      document.addEventListener('animationstart', event => window.__started.push({ name: event.animationName, id: event.target.id, pseudo: event.pseudoElement, className: event.target.className }))
      window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764))
    })
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit')
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')

    await step('a successful probe on the dashboard flashes the top badge dot and value once', async () => {
      await started()
      // 回到前台会立即补测，不必等工作台 30 秒的间隔。
      await page.evaluate(() => { window.qingVisibility(false); window.qingVisibility(true) })
      await page.waitForFunction(() => window.__started.some(item => item.name === 'ping-value' && item.id === 'home-latency'), undefined, { timeout: 13000 })
      await page.waitForTimeout(600)
      const flashes = await started()
      assert.equal(flashes.filter(item => item.name === 'ping-dot' && String(item.className).includes('dot')).length, 1)
      assert.equal(flashes.filter(item => item.name === 'ping-value' && item.id === 'home-latency').length, 1)
      // 自动化窗口被节流时 animationend 会延后，等类名清掉即可。
      await page.waitForFunction(() => !document.querySelector('#active-host .dot').classList.contains('ping-flash'), undefined, { timeout: 13000 })
    })

    await step('switching dashboard pages plays the entrance once', async () => {
      await started()
      await page.click('#dashboard-nav [data-page="project"]')
      await page.waitForFunction(() => window.__started.some(item => item.id === 'project-screen') && window.__started.filter(item => item.name === 'rise-in').length >= 2)
      const entrance = await started()
      assert.equal(entrance.filter(item => item.name === 'page-in' && item.id === 'project-screen').length, 1)
      // 按导航顺序往右切换：页面从右侧滑入，导航图标弹一下，页面分区依次上浮。
      assert.equal(await page.evaluate(() => document.querySelector('#dashboard').dataset.direction), 'forward')
      assert.ok(entrance.some(item => item.name === 'nav-pop'), JSON.stringify(entrance))
      assert.ok(entrance.filter(item => item.name === 'rise-in').length >= 2, JSON.stringify(entrance))
      await page.waitForFunction(() => !document.querySelector('#project-screen').getAnimations({ subtree: true }).some(animation => animation.animationName === 'rise-in' || animation.animationName === 'page-in'))
      // 分区入场只用 backwards 填充，结束后不残留 transform（否则吸顶搜索与固定元素会以它为容器）。
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#project-filters')).transform), 'none')
    })

    await step('switching back to the left page slides in from the left', async () => {
      await page.click('#dashboard-nav [data-page="home"]')
      await page.waitForFunction(() => window.__started.some(item => item.name === 'page-in' && item.id === 'home-screen'))
      assert.equal(await page.evaluate(() => document.querySelector('#dashboard').dataset.direction), 'back')
      await page.click('#dashboard-nav [data-page="project"]')
      await page.waitForFunction(() => !document.querySelector('#project-screen').hidden && document.querySelector('#dashboard').dataset.direction === 'forward')
      await page.waitForFunction(() => !document.querySelector('#project-screen').getAnimations({ subtree: true }).length)
      await started()
    })

    await step('the selected navigation pill grows from the centre', async () => {
      const pill = await page.evaluate(() => {
        const read = selector => { const style = getComputedStyle(document.querySelector(selector), '::before'); return { opacity: style.opacity, transform: style.transform } }
        return { current: read('#dashboard-nav [data-page="project"] .nav-icon'), other: read('#dashboard-nav [data-page="home"] .nav-icon') }
      })
      assert.deepEqual(pill.current, { opacity: '1', transform: 'none' })
      assert.equal(pill.other.opacity, '0')
      assert.notEqual(pill.other.transform, 'none')
    })

    await page.click('#project-list > :first-child .project-row:first-child .row')
    await step('opening a project settles the header title in place, without flying across the screen', async () => {
      await page.waitForFunction(() => window.__started.some(item => item.name === 'title-settle'))
      // 只读不清：下一步还要等终端页的淡入事件。
      const settles = await page.evaluate(() => window.__started.filter(item => item.name === 'title-settle'))
      assert.equal(settles.length, 1)
      assert.equal(settles[0].className, 'terminal-heading')
      // 起点只在原位下方 6px，不缩放；结束后不残留 transform。
      const from = await page.evaluate(() => {
        const animation = document.querySelector('.terminal-heading').getAnimations().find(item => item.animationName === 'title-settle')
        return animation ? animation.effect.getKeyframes()[0].transform : 'finished'
      })
      assert.ok(from === 'finished' || from === 'translateY(6px)', from)
      await page.waitForFunction(() => !document.querySelector('.terminal-heading').getAnimations().length)
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.terminal-heading')).transform), 'none')
    })
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
    await page.evaluate(() => window.qingOrientation?.(false))

    await step('the terminal only fades in, so grid measurement is never offset', async () => {
      // 动画事件随渲染帧派发，自动化窗口可能被节流，要等而不是立刻读。
      await page.waitForFunction(() => window.__started.some(item => item.name === 'fade-in' && item.id === 'terminal-screen'))
    })

    await step('a pressed button scales down', async () => {
      const scale = await press('#terminal-menu', scaleOf)
      assert.ok(Math.abs(scale - .97) < .001, `button scale ${scale}`)
    })

    await step('a closing dialog keeps its close semantics and lets clicks through', async () => {
      await page.click('#terminal-menu')
      await page.waitForFunction(() => !document.querySelector('#terminal-menu-dialog').getAnimations().length)
      const state = await page.evaluate(() => {
        window.__closed = 0
        document.querySelector('#terminal-menu-dialog').addEventListener('close', () => { window.__closed += 1 }, { once: true })
      }).then(() => closing('terminal-menu-dialog'))
      assert.equal(state.open, false)
      assert.notEqual(state.display, 'none')
      assert.equal(state.pointerEvents, 'none')
      assert.equal(state.hitsDialog, false)
      await gone('terminal-menu-dialog')
      assert.equal(await page.evaluate(() => window.__closed), 1)
    })

    await step('reopening during the exit leaves a fully visible dialog', async () => {
      const state = await page.evaluate(async () => {
        const dialog = document.querySelector('#terminal-menu-dialog')
        dialog.showModal()
        await new Promise(done => setTimeout(done, 480))
        dialog.close('cancel')
        await new Promise(done => setTimeout(done, 40))
        dialog.showModal()
        await new Promise(done => setTimeout(done, 560))
        const style = getComputedStyle(dialog)
        return { open: dialog.open, opacity: style.opacity, transform: style.transform, display: style.display }
      })
      assert.deepEqual(state, { open: true, opacity: '1', transform: 'none', display: state.display })
      assert.notEqual(state.display, 'none')
      await page.evaluate(() => document.querySelector('#terminal-menu-dialog').close('cancel'))
      await gone('terminal-menu-dialog')
    })

    await step('the drawer leaves sideways, and the back key closes it the same way', async () => {
      await page.click('#show-sessions')
      await page.waitForFunction(() => document.querySelector('#session-drawer').open && !document.querySelector('#session-drawer').getAnimations().length)
      const state = await closing('session-drawer')
      assert.ok(state.properties.includes('transform'), JSON.stringify(state))
      await gone('session-drawer')
      await page.click('#show-sessions')
      await page.waitForFunction(() => document.querySelector('#session-drawer').open)
      assert.equal(await page.evaluate(() => window.qingBack()), true)
      assert.equal(await page.evaluate(() => document.querySelector('#session-drawer').open), false)
      await gone('session-drawer')
    })

    await step('a received submission pops its check once', async () => {
      await started()
      await page.fill('#compose', 'motion receipt')
      await page.click('#send')
      await page.waitForFunction(() => window.__started.some(item => item.name === 'receipt-pop'))
      const pops = (await started()).filter(item => item.name === 'receipt-pop')
      assert.equal(pops.length, 1)
      assert.equal(pops[0].pseudo, '::before')
    })

    await step('each successful probe flashes the status dot and the value, failures stay quiet', async () => {
      await started()
      await page.waitForFunction(() => window.__started.some(item => item.name === 'ping-dot'), undefined, { timeout: 13000 })
      await page.waitForTimeout(600)
      const flashes = await started()
      assert.equal(flashes.filter(item => item.name === 'ping-dot' && item.id === 'terminal-dot').length, 1)
      assert.equal(flashes.filter(item => item.name === 'ping-value' && item.id === 'terminal-latency').length, 1)
      assert.equal(await page.evaluate(() => document.querySelector('#terminal-dot').classList.contains('ping-flash')), false)
      const requests = await page.evaluate(() => { window.__mobileFixture.state.latencyError = '模拟探测失败'; return window.__mobileFixture.state.latencyRequests.length })
      await page.waitForFunction(count => window.__mobileFixture.state.latencyRequests.length > count, requests, { timeout: 13000 })
      await page.waitForTimeout(600)
      assert.equal((await started()).filter(item => item.name.startsWith('ping-')).length, 0)
      await page.evaluate(() => { window.__mobileFixture.state.latencyError = null })
    })

    await step('the virtual mouse grows from the arrow tip without leaving its position', async () => {
      await started()
      await page.click('#terminal-menu')
      await page.click('#menu-mouse')
      await page.waitForSelector('.mouse-mode-pill:not([hidden])')
      await page.waitForFunction(() => window.__started.some(item => item.name === 'float-in' && String(item.className).includes('mouse-mode-pill'))
        && window.__started.some(item => item.name === 'mouse-grow' && String(item.className).includes('virtual-mouse')))
      await page.waitForFunction(() => !document.querySelector('.virtual-mouse').getAnimations().some(animation => animation.playState === 'running'))
      const placement = await page.evaluate(() => {
        const body = document.querySelector('.virtual-mouse')
        const settled = body.getBoundingClientRect()
        const flip = body.style.transformOrigin
        const grow = new Animation(new KeyframeEffect(body, [{ transform: 'scale(.7)' }, { transform: 'scale(1)' }], { duration: 1000, composite: 'add' }), document.timeline)
        grow.pause()
        grow.currentTime = 0
        const start = body.getBoundingClientRect()
        grow.cancel()
        return { flip, settled: { left: settled.left, top: settled.top, right: settled.right, bottom: settled.bottom, width: settled.width }, start: { left: start.left, top: start.top, right: start.right, bottom: start.bottom, width: start.width } }
      })
      assert.ok(Math.abs(placement.start.width - placement.settled.width * .7) < 1, JSON.stringify(placement))
      const [x, y] = placement.flip.split(' ')
      const anchorX = x.startsWith('100') ? 'right' : 'left'
      const anchorY = y.startsWith('100') ? 'bottom' : 'top'
      assert.ok(Math.abs(placement.start[anchorX] - placement.settled[anchorX]) < 1, JSON.stringify(placement))
      assert.ok(Math.abs(placement.start[anchorY] - placement.settled[anchorY]) < 1, JSON.stringify(placement))
      await page.screenshot({ path: resolve(output, 'virtual-mouse.png') })
    })

    await step('pressing a virtual mouse button dips it', async () => {
      const scale = await press('.virtual-mouse-button[data-button="2"]', scaleOf)
      assert.ok(Math.abs(scale - .95) < .001, `mouse button scale ${scale}`)
      await page.evaluate(() => window.qingBack())
      if (await page.evaluate(() => !document.querySelector('.mouse-mode-pill').hidden)) await page.click('.mouse-mode-pill')
    })

    await step('closing one session collapses its row in place', async () => {
      for (let count = 2; count <= 3; count++) {
        await page.click('#new-session')
        await page.click('[data-profile="default"]')
        await page.waitForFunction(n => window.__mobileFixture.state.sessions.size === n
          && document.querySelector('#terminal-status').textContent === '会话中', count)
      }
      await page.click('#show-sessions')
      await page.waitForFunction(() => document.querySelector('#session-drawer').open && !document.querySelector('#session-drawer').getAnimations().length)
      const order = await page.evaluate(() => {
        window.__leaving = []
        const options = document.querySelector('#session-options')
        window.__leavingObserver = new MutationObserver(() => {
          const row = options.querySelector('[data-leaving]')
          if (row && !window.__leaving.length) window.__leaving.push({ index: [...options.children].indexOf(row), id: row.dataset.id, animated: row.getAnimations().length > 0 })
        })
        window.__leavingObserver.observe(options, { subtree: true, attributes: true, attributeFilter: ['data-leaving'] })
        return [...options.children].map(row => row.dataset.id)
      })
      assert.equal(order.length, 3)
      const target = order[1]
      await page.evaluate(selector => document.querySelector(selector).click(), `#session-options [data-id="${target}"] .session-close`)
      await page.waitForSelector('#confirm-dialog[open]')
      await page.click('#confirm-action')
      await page.waitForFunction(() => document.querySelectorAll('#session-options .session-option').length === 2)
      const leaving = await page.evaluate(() => { window.__leavingObserver.disconnect(); return window.__leaving })
      assert.deepEqual(leaving, [{ index: 1, id: target, animated: true }])
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#session-options > *')].map(row => row.dataset.id)), order.filter(id => id !== target))
    })

    await step('a pressed list row only tints softly, without shrinking or a ripple', async () => {
      // 抽屉刷新时复用行节点；项目列表会整表重建，强制的伪类会落在旧节点上。
      // 当前会话按设计保留自身底色，取一行非当前会话。
      const selector = '#session-options .session-option:not([data-current="true"]) .row'
      const state = await press(selector, target => {
        const element = document.querySelector(target)
        const style = getComputedStyle(element)
        return { transform: style.transform, background: style.backgroundColor, image: style.backgroundImage, press: getComputedStyle(document.documentElement).getPropertyValue('--press').trim() }
      })
      assert.equal(state.transform, 'none')
      assert.equal(state.image, 'none')
      // 状态层是 5% 白（深色主题），不是整块 --raised。
      assert.equal(state.background, 'rgba(255, 255, 255, 0.05)', JSON.stringify(state))
      assert.equal(state.press, '#ffffff0d')
    })

    await step('the running spinner and the pin centre on the first title line', async () => {
      await page.evaluate(() => {
        const row = document.querySelector('#session-options .session-option')
        row.dataset.running = 'true'
        row.dataset.pinned = 'true'
        row.querySelector('.session-label').textContent = '鼠标箭头样式与宽度鼠标箭头样式与宽度鼠标箭头样式与宽度鼠标箭头样式与宽度'
      })
      const offsets = await page.evaluate(() => {
        const row = document.querySelector('#session-options .session-option')
        const range = document.createRange()
        range.selectNodeContents(row.querySelector('.session-label'))
        const rects = [...range.getClientRects()]
        // 按行盒算首行中线：回退字体的文字矩形高度因机器而异，不能代表视觉中线。
        const label = row.querySelector('.session-label')
        const line = label.getBoundingClientRect().top + parseFloat(getComputedStyle(label).lineHeight) / 2
        const middle = rect => rect.top + rect.height / 2
        return { lines: new Set(rects.map(rect => Math.round(rect.top))).size, spinner: middle(row.querySelector('.session-spinner').getBoundingClientRect()) - line, pin: middle(row.querySelector('.session-pin').getBoundingClientRect()) - line }
      })
      assert.ok(offsets.lines >= 2, JSON.stringify(offsets))
      assert.ok(Math.abs(offsets.spinner) <= 1, JSON.stringify(offsets))
      assert.ok(Math.abs(offsets.pin) <= 1, JSON.stringify(offsets))
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
      await page.waitForTimeout(200)
      await page.screenshot({ path: resolve(output, 'session-row.png') })
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    })

    await step('a full-screen page stays full screen while it leaves, with no dark backdrop', async () => {
      const state = await page.evaluate(async () => {
        const dialog = document.querySelector('#settings-dialog')
        dialog.showModal()
        await new Promise(done => setTimeout(done, 480))
        dialog.close('cancel')
        // 退出过渡刚开始：open 已移除但仍在显示，几何与底色必须和打开时一致。
        const style = getComputedStyle(dialog)
        const rect = dialog.getBoundingClientRect()
        return { open: dialog.open, display: style.display, width: rect.width, height: rect.height, radius: style.borderRadius, background: style.backgroundColor, paper: getComputedStyle(document.body).backgroundColor, backdrop: getComputedStyle(dialog, '::backdrop').backgroundColor, properties: dialog.getAnimations().map(animation => animation.transitionProperty) }
      })
      assert.equal(state.open, false)
      assert.notEqual(state.display, 'none')
      assert.equal(state.width, 390)
      assert.equal(state.height, 844)
      assert.equal(state.radius, '0px')
      assert.equal(state.background, state.paper)
      assert.equal(state.backdrop, 'rgba(0, 0, 0, 0)')
      assert.ok(state.properties.includes('transform') && state.properties.includes('opacity'), JSON.stringify(state))
      await gone('settings-dialog')
    })

    await step('a terminal menu handing off to a sub-page vanishes at once, so only the sub-page slides', async () => {
      await page.click('#terminal-menu')
      await page.waitForFunction(() => !document.querySelector('#terminal-menu-dialog').getAnimations().length)
      const state = await page.evaluate(() => {
        document.querySelector('#menu-read').click()
        const menu = document.querySelector('#terminal-menu-dialog')
        return { open: menu.open, opacity: getComputedStyle(menu).opacity, properties: menu.getAnimations().map(animation => animation.transitionProperty), reader: document.querySelector('#reader-dialog').open }
      })
      assert.equal(state.open, false)
      assert.equal(state.opacity, '0')
      assert.ok(!state.properties.includes('transform') && !state.properties.includes('opacity'), JSON.stringify(state))
      assert.equal(state.reader, true)
      await gone('terminal-menu-dialog')
      await page.evaluate(() => window.qingBack())
      await gone('reader-dialog')
      // 之后点遮罩正常关闭菜单仍然下滑，不受上次交接影响。
      await page.click('#terminal-menu')
      await page.waitForFunction(() => !document.querySelector('#terminal-menu-dialog').getAnimations().length)
      const plain = await closing('terminal-menu-dialog')
      assert.ok(plain.properties.includes('transform'), JSON.stringify(plain))
      await gone('terminal-menu-dialog')
    })

    await step('project files slide in like the other sub-pages, and folders slide by depth', async () => {
      await started()
      await page.click('#terminal-menu')
      await page.waitForFunction(() => !document.querySelector('#terminal-menu-dialog').getAnimations().length)
      await page.click('#menu-files')
      await page.waitForFunction(() => document.querySelector('#files-list [data-path="src"]'))
      await page.waitForFunction(() => window.__started.some(item => item.name === 'workspace-in' && item.id === 'files-dialog'))
      await page.click('#files-list [data-path="src"]')
      await page.waitForFunction(() => document.querySelector('#files-list').dataset.slide === 'forward' && document.querySelector('#files-list [data-path="src/中文说明.txt"]'))
      await page.waitForFunction(() => window.__started.some(item => item.name === 'folder-in'))
      await page.evaluate(() => window.qingBack())
      await page.waitForFunction(() => document.querySelector('#files-list').dataset.slide === 'back' && document.querySelector('#files-list [data-path="src"]'))
      await page.waitForFunction(() => !document.querySelector('#files-list').getAnimations().length)
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#files-list')).transform), 'none')
      const leaving = await closing('files-dialog')
      assert.ok(leaving.properties.includes('transform') && leaving.properties.includes('opacity'), JSON.stringify(leaving))
      await gone('files-dialog')
    })

    await step('a small hint fades out instead of vanishing', async () => {
      const state = await page.evaluate(() => {
        const button = document.querySelector('#scroll-bottom')
        button.hidden = false
        getComputedStyle(button).opacity
        for (const animation of button.getAnimations()) animation.finish()
        // 先让完全显示的样式生效，再隐藏，模拟真实的停留。
        getComputedStyle(button).opacity
        button.hidden = true
        const style = getComputedStyle(button)
        return { display: style.display, pointerEvents: style.pointerEvents, properties: button.getAnimations().map(animation => animation.transitionProperty) }
      })
      assert.notEqual(state.display, 'none')
      assert.equal(state.pointerEvents, 'none')
      assert.ok(state.properties.includes('opacity'), JSON.stringify(state))
      await gone('scroll-bottom')
    })

    await step('returning from the terminal: the terminal snapshot leaves to the right, the dashboard slides in from the left', async () => {
      await started()
      await page.evaluate(() => window.qingBack())
      await page.waitForFunction(() => !document.querySelector('#dashboard').hidden)
      assert.equal(await page.evaluate(() => document.querySelector('#dashboard').dataset.direction), 'back')
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#dashboard')).getPropertyValue('--page-shift').trim()), '-28px')
      await page.waitForFunction(() => window.__started.some(item => item.name === 'screen-out' && item.pseudo === '::view-transition-old(root)'))
      // 停在退出中段截图：快照里应是离开前的终端画面（保留了最后一帧），不是空白终端。
      const paused = await page.evaluate(() => {
        const exit = document.getAnimations().find(animation => animation.animationName === 'screen-out')
        if (!exit) return false
        exit.pause()
        exit.currentTime = 90
        return true
      })
      if (paused) {
        await page.screenshot({ path: resolve(output, 'screen-exit-terminal.png') })
        await page.evaluate(() => document.getAnimations().find(animation => animation.animationName === 'screen-out')?.play())
      }
      // 快照方向写在 html 上，过渡结束后清除。
      await page.waitForFunction(() => !document.documentElement.dataset.screenExit)
      // 回到终端供后续步骤使用：进入时工作台快照往左退出。
      await page.waitForFunction(() => !document.querySelector('#resume').hidden)
      await started()
      const direction = await page.evaluate(() => { document.querySelector('#resume').click(); return document.documentElement.dataset.screenExit })
      assert.equal(direction, 'forward')
      await page.waitForFunction(() => !document.querySelector('#terminal-screen').hidden && document.querySelector('#terminal-status').textContent === '会话中')
      await page.waitForFunction(() => window.__started.some(item => item.name === 'screen-out'))
    })

    await step('the in-app "reduce motion" setting turns motion off without the system switch', async () => {
      await page.evaluate(() => { document.querySelector('#app-motion').value = 'reduce'; document.querySelector('#app-motion').dispatchEvent(new Event('change')) })
      assert.equal(await page.evaluate(() => [document.documentElement.dataset.motion, localStorage.getItem('qingcode:mobile:motion')].join()), 'reduce,reduce')
      await started()
      const state = await page.evaluate(() => {
        const dialog = document.querySelector('#settings-dialog')
        dialog.showModal()
        const opened = dialog.getAnimations().length
        dialog.close('cancel')
        return { opened, closing: getComputedStyle(dialog).display }
      })
      assert.deepEqual(state, { opened: 0, closing: 'none' })
      await page.waitForTimeout(400)
      assert.deepEqual((await started()).map(item => item.name), [])
      await page.evaluate(() => { document.querySelector('#app-motion').value = 'auto'; document.querySelector('#app-motion').dispatchEvent(new Event('change')) })
      assert.equal(await page.evaluate(() => document.documentElement.dataset.motion ?? 'unset'), 'unset')
    })

    await step('reduced motion turns all of it off', async () => {
      await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await started()
      const display = await page.evaluate(() => {
        const drawer = document.querySelector('#session-drawer')
        drawer.close('cancel')
        return getComputedStyle(drawer).display
      })
      assert.equal(display, 'none')
      const scale = await press('#terminal-menu', scaleOf)
      assert.equal(scale, 1)
      // 减少动画时工作台切换不播放入场、指示块和图标弹跳。
      await page.evaluate(() => window.qingBack())
      await page.waitForFunction(() => !document.querySelector('#dashboard').hidden)
      await page.click('#dashboard-nav [data-page="connection"]')
      await page.waitForFunction(() => !document.querySelector('#connection-screen').hidden)
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#dashboard-nav [data-page="connection"] .nav-icon'), '::before').transitionDuration), '0s')
      await page.waitForTimeout(11000)
      assert.deepEqual((await started()).map(item => item.name).filter(name => !['spin', 'compose-spin'].includes(name)), [])
    })
  } catch (error) {
    results.push({ name: 'failure', passed: false, error: String(error?.stack ?? error) })
    try { await page.screenshot({ path: resolve(output, 'failure.png') }) } catch {}
    throw error
  } finally {
    await page.cdp('Emulation.setEmulatedMedia', { features: [] }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results }, null, 2))
    console.log(JSON.stringify({ spaceId: task.spaceId, results }, null, 2))
  }
}
