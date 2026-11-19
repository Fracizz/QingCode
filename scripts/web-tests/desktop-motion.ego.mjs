import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 电脑端动效（DESIGN.md「动效一览」）：弹窗 / 菜单 / 通知的退出残影、层间交接、侧栏原地换页入场、终端浮条进出、去掉悬停上浮和应用内减少动效。
 * 先启动 `pnpm test:web`；动画时间依赖页面不被节流，建议用 headless-task-space.mjs 运行。
 */
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir } = {}) {
  const task = await taskSpace(spaceId ?? 'QingCode desktop motion')
  const page = task.page('p1')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/desktop-motion')
  await mkdir(output, { recursive: true })
  const results = []
  const step = async (name, action) => {
    await action()
    results.push({ name, status: 'passed' })
    console.log(`PASS ${name}`)
  }
  const shot = name => page.screenshot({ path: resolve(output, `${name}.png`) })
  const settle = () => page.waitForTimeout(320)
  const ghostCount = () => page.evaluate(() => document.querySelectorAll('[data-exit-ghost]').length)
  const waitGhostsGone = () => page.waitForFunction(() => document.querySelectorAll('[data-exit-ghost]').length === 0)

  try {
    // 测试机系统可能开着减少动画，固定为允许动画，才能走到退出路径。
    await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    // 不做视口模拟：无头 Chrome 在设备模拟下会推迟动画起播约 80ms，测不出真实节奏。
    await page.goto(`${baseUrl}/web-tests/desktop-motion.html`)
    await page.evaluate(() => { localStorage.removeItem('qingcode:motion'); delete document.documentElement.dataset.motion })
    await page.waitForSelector('[data-testid="open-draft"]')

    await step('弹窗关闭留下只读残影淡出，真实弹窗立即卸载', async () => {
      await page.click('[data-testid="open-draft"]')
      await page.waitForSelector('[data-testid="draft"]')
      await settle()
      await page.fill('[data-testid="draft"]', '未保存的草稿')
      await page.evaluate(() => { document.querySelector('[data-testid="scroller"]').scrollTop = 80 })
      const state = await page.evaluate(async () => {
        const close = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === '关闭')
        const start = performance.now()
        close.click()
        await new Promise(r => setTimeout(r, 10))
        const ghost = document.querySelector('[data-exit-ghost]')
        const panel = ghost?.querySelector('.modal-content-enter')
        const box = panel?.getBoundingClientRect()
        const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null
        const snapshot = {
          ghosts: document.querySelectorAll('[data-exit-ghost]').length,
          realDialogs: document.querySelectorAll('[role="dialog"]').length,
          overlays: document.querySelectorAll('[data-modal-overlay]').length,
          inert: ghost?.hasAttribute('inert'),
          ariaHidden: ghost?.getAttribute('aria-hidden'),
          idsOrRoles: ghost?.querySelectorAll('[id], [role]').length,
          draft: ghost?.querySelector('input')?.value,
          scrollTop: ghost?.querySelector('.overflow-auto')?.scrollTop,
          cssAnimation: panel ? getComputedStyle(panel).animationName : null,
          webAnimations: ghost?.getAnimations({ subtree: true }).length,
          clickThrough: hit ? !ghost.contains(hit) : null,
        }
        // 逐帧采样：多久开始变淡、途中出现过的半透明值、多久彻底移除。
        let fadeStartedAt = null
        let midOpacity = null
        while (ghost?.isConnected && performance.now() - start < 1000) {
          await new Promise(r => requestAnimationFrame(r))
          const opacity = Number(getComputedStyle(ghost).opacity)
          if (opacity < 1 && fadeStartedAt === null) fadeStartedAt = performance.now() - start
          if (opacity > 0.05 && opacity < 0.95) midOpacity = opacity
        }
        return { ...snapshot, midOpacity, fadeStartedAt: Math.round(fadeStartedAt), removedAt: Math.round(performance.now() - start) }
      })
      console.log('modal exit', state)
      assert.equal(state.ghosts, 1)
      assert.equal(state.realDialogs, 0)
      assert.equal(state.overlays, 0)
      assert.equal(state.inert, true)
      assert.equal(state.ariaHidden, 'true')
      assert.equal(state.idsOrRoles, 0)
      assert.equal(state.draft, '未保存的草稿')
      assert.equal(state.scrollTop, 80)
      assert.equal(state.cssAnimation, 'none', '残影不能重播入场动画')
      assert.equal(state.webAnimations, 2, '整体淡出 + 面板微缩')
      assert.ok(state.midOpacity !== null, '退出途中出现半透明帧')
      assert.ok(state.fadeStartedAt <= 60, `点击后 60ms 内开始淡出：${state.fadeStartedAt}ms`)
      assert.ok(state.removedAt <= 250, `250ms 内移除残影：${state.removedAt}ms`)
      assert.equal(state.clickThrough, true, '残影不挡点击')
      await waitGhostsGone()
    })

    await step('弹窗直接换成另一个：旧面板立即让位，遮罩不重新淡入', async () => {
      await page.click('[data-testid="open-draft"]')
      await page.waitForSelector('[data-testid="draft"]')
      await settle()
      const state = await page.evaluate(async () => {
        const replace = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === '换成另一个弹窗')
        replace.click()
        await new Promise(r => setTimeout(r, 10))
        const overlay = document.querySelector('[data-modal-overlay]')
        return {
          ghosts: document.querySelectorAll('[data-exit-ghost]').length,
          title: document.querySelector('[role="dialog"]')?.getAttribute('aria-label'),
          handoff: overlay?.hasAttribute('data-modal-handoff'),
          backdropAnimation: getComputedStyle(overlay.querySelector('.modal-overlay-enter')).animationName,
          panelAnimation: getComputedStyle(overlay.querySelector('.modal-content-enter')).animationName,
        }
      })
      console.log('modal handoff', state)
      assert.deepEqual(state, {
        ghosts: 0,
        title: '替换后的弹窗',
        handoff: true,
        backdropAnimation: 'none',
        panelAnimation: 'modal-content-in',
      })
      await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === '关闭').click())
      await waitGhostsGone()
    })

    await step('菜单点开弹窗：菜单直接让位，弹窗遮罩照常淡入', async () => {
      await page.click('[data-testid="open-menu"]')
      await page.waitForSelector('[data-qingcode-context-menu]')
      await settle()
      const state = await page.evaluate(async () => {
        const item = [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.includes('从菜单打开弹窗'))
        item.click()
        await new Promise(r => setTimeout(r, 10))
        const overlay = document.querySelector('[data-modal-overlay]')
        return {
          ghosts: document.querySelectorAll('[data-exit-ghost]').length,
          menus: document.querySelectorAll('[data-qingcode-context-menu]').length,
          title: document.querySelector('[role="dialog"]')?.getAttribute('aria-label'),
          handoff: overlay?.hasAttribute('data-modal-handoff'),
          backdropAnimation: getComputedStyle(overlay.querySelector('.modal-overlay-enter')).animationName,
        }
      })
      console.log('menu to dialog', state)
      assert.deepEqual(state, {
        ghosts: 0,
        menus: 0,
        title: '从菜单打开',
        handoff: false,
        backdropAnimation: 'modal-overlay-in',
      })
      await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === '关闭').click())
      await waitGhostsGone()
    })

    await step('菜单按 Escape 关闭时淡出，残影不被当成菜单', async () => {
      await page.click('[data-testid="open-menu"]')
      await page.waitForSelector('[data-qingcode-context-menu]')
      await settle()
      const state = await page.evaluate(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await new Promise(r => setTimeout(r, 10))
        const ghost = document.querySelector('[data-exit-ghost]')
        return {
          ghosts: document.querySelectorAll('[data-exit-ghost]').length,
          menus: document.querySelectorAll('[data-qingcode-context-menu]').length,
          roleMenus: document.querySelectorAll('[role="menu"]').length,
          webAnimations: ghost?.getAnimations({ subtree: true }).length,
        }
      })
      console.log('menu exit', state)
      assert.deepEqual(state, { ghosts: 1, menus: 0, roleMenus: 0, webAnimations: 1 })
      await waitGhostsGone()
    })

    await step('通知关闭时固定在原位淡出右移，堆栈立即补位', async () => {
      await page.click('[data-testid="push-toast"]')
      await page.click('[data-testid="push-toast"]')
      await page.waitForSelector('.toast-item')
      await settle()
      await shot('toasts')
      const state = await page.evaluate(async () => {
        const first = document.querySelector('[data-floating-task-stack] .toast-item')
        const before = first.getBoundingClientRect()
        first.querySelector('button[aria-label="关闭通知"]').click()
        await new Promise(r => setTimeout(r, 10))
        const ghost = document.querySelector('[data-exit-ghost]')
        const box = ghost.getBoundingClientRect()
        await new Promise(r => setTimeout(r, 50))
        const moved = ghost.getBoundingClientRect().left - before.left
        return {
          ghosts: document.querySelectorAll('[data-exit-ghost]').length,
          parentIsBody: ghost.parentElement === document.body,
          position: getComputedStyle(ghost).position,
          sameSpot: Math.abs(box.top - before.top) < 1 && Math.abs(box.width - before.width) < 1,
          remaining: document.querySelectorAll('[data-floating-task-stack] .toast-item').length,
          movedRight: moved > 0 && moved <= 8,
        }
      })
      console.log('toast exit', state)
      assert.deepEqual(state, { ghosts: 1, parentIsBody: true, position: 'fixed', sameSpot: true, remaining: 1, movedRight: true })
      await waitGhostsGone()
      await page.evaluate(() => document.querySelector('button[aria-label="关闭通知"]')?.click())
      await waitGhostsGone()
    })

    await step('侧栏换页：新面板淡入右移入场，旧面板不留残影，播完不残留 transform', async () => {
      await page.click('[data-testid="view-explorer"]')
      await settle()
      const state = await page.evaluate(async () => {
        document.querySelector('[data-testid="view-search"]').click()
        await new Promise(r => setTimeout(r, 10))
        const view = document.querySelector('[data-testid="sidebar-view"]')
        const snapshot = {
          view: view.dataset.view,
          views: document.querySelectorAll('[data-testid="sidebar-view"]').length,
          ghosts: document.querySelectorAll('[data-exit-ghost]').length,
          animation: getComputedStyle(view).animationName,
        }
        let midOpacity = null
        let shifted = false
        const start = performance.now()
        while (performance.now() - start < 400) {
          await new Promise(r => requestAnimationFrame(r))
          const style = getComputedStyle(view)
          const opacity = Number(style.opacity)
          if (opacity > 0.05 && opacity < 0.95) midOpacity = opacity
          if (style.transform !== 'none') shifted = true
        }
        return { ...snapshot, midOpacity, shifted, endTransform: getComputedStyle(view).transform, endOpacity: getComputedStyle(view).opacity }
      })
      console.log('sidebar view enter', state)
      assert.equal(state.view, 'search')
      assert.equal(state.views, 1, '旧面板立即卸载')
      assert.equal(state.ghosts, 0, '换页不做退出残影')
      assert.equal(state.animation, 'view-in')
      assert.ok(state.midOpacity !== null, '入场途中出现半透明帧')
      assert.equal(state.shifted, true, '入场有位移')
      assert.equal(state.endTransform, 'none', '播完不残留 transform')
      assert.equal(state.endOpacity, '1')
      await shot('sidebar-view-enter')
    })

    await step('侧栏收起 / 展开：宽度在 0 与侧栏宽度间平滑过渡，右侧区域跟随平移，播完卸载或恢复', async () => {
      await settle()
      // 在页面内逐帧采样槽宽与右侧区域位置；sampleMs 内记录全部帧。
      const sample = async (sampleMs) => page.evaluate(async (ms) => {
        const host = document.querySelector('[data-testid="terminal-host"]')
        const slotOf = () => document.querySelector('[data-testid="sidebar-view"]')?.parentElement ?? null
        document.querySelector('[data-testid="toggle-sidebar"]').click()
        const widths = []
        const hostLefts = []
        let clipped = false
        const start = performance.now()
        while (performance.now() - start < ms) {
          await new Promise(r => requestAnimationFrame(r))
          const slot = slotOf()
          widths.push(slot ? Math.round(slot.getBoundingClientRect().width) : null)
          hostLefts.push(Math.round(host.getBoundingClientRect().left))
          if (slot && slot.style.overflow === 'hidden' && slot.style.justifyContent === 'flex-end') clipped = true
        }
        const slot = slotOf()
        return {
          widths,
          hostLefts,
          clipped,
          mounted: Boolean(slot),
          endWidth: slot ? Math.round(slot.getBoundingClientRect().width) : null,
          endOverflow: slot ? slot.style.overflow : null,
          inert: slot ? slot.hasAttribute('inert') : null,
        }
      }, sampleMs)

      const closing = await sample(400)
      console.log('sidebar close', { ...closing, widths: closing.widths.join(',') })
      const midClose = closing.widths.filter(w => w !== null && w > 5 && w < 195)
      assert.ok(midClose.length >= 2, `收起途中出现多帧中间宽度：${closing.widths.join(',')}`)
      assert.equal(closing.clipped, true, '收起时内容贴右裁切')
      assert.equal(closing.mounted, false, '收拢播完后卸载')
      assert.ok(new Set(closing.hostLefts).size >= 3, '右侧区域随宽度逐帧左移')
      await shot('sidebar-closed')

      const opening = await sample(400)
      console.log('sidebar open', { ...opening, widths: opening.widths.join(',') })
      const midOpen = opening.widths.filter(w => w !== null && w > 5 && w < 195)
      assert.ok(midOpen.length >= 2, `展开途中出现多帧中间宽度：${opening.widths.join(',')}`)
      assert.equal(opening.clipped, true, '展开时内容贴右裁切')
      assert.equal(opening.endWidth, 200, '展开到侧栏宽度')
      assert.equal(opening.endOverflow, '', '播完移除裁切')
      assert.equal(opening.inert, false)
      await shot('sidebar-reopened')
    })

    for (const [name, open, close, selector] of [
      ['终端搜索条', 'toggle-search', 'toggle-search', '.terminal-search-bar'],
      ['终端连接提示', 'show-notice', 'clear-notice', '[data-testid="terminal-connection-notice"]'],
    ]) {
      await step(`${name}：下落淡入，关闭时残影留在终端容器内上移淡出`, async () => {
        await page.click(`[data-testid="${open}"]`)
        await page.waitForSelector(selector)
        const enter = await page.evaluate(sel => getComputedStyle(document.querySelector(sel)).animationName, selector)
        await settle()
        await shot(`float-${open}`)
        const state = await page.evaluate(async ([sel, closeId]) => {
          const before = document.querySelector(sel).getBoundingClientRect()
          document.querySelector(`[data-testid="${closeId}"]`).click()
          await new Promise(r => setTimeout(r, 10))
          const ghost = document.querySelector('[data-exit-ghost]')
          const box = ghost?.getBoundingClientRect()
          await new Promise(r => setTimeout(r, 50))
          const moved = ghost ? ghost.getBoundingClientRect().top - before.top : null
          return {
            ghosts: document.querySelectorAll('[data-exit-ghost]').length,
            real: [...document.querySelectorAll(sel)].filter(el => !el.closest('[data-exit-ghost]')).length,
            inHost: ghost?.parentElement === document.querySelector('[data-testid="terminal-host"]'),
            sameSpot: box ? Math.abs(box.left - before.left) < 1 && Math.abs(box.width - before.width) < 1 : false,
            testIds: ghost?.querySelectorAll('[data-testid]').length ?? -1,
            movedUp: moved !== null && moved < 0 && moved >= -4,
          }
        }, [selector, close])
        console.log(`${name} exit`, { enter, ...state })
        assert.equal(enter, 'float-in')
        assert.deepEqual(state, { ghosts: 1, real: 0, inHost: true, sameSpot: true, testIds: 0, movedUp: true })
        await waitGhostsGone()
      })
    }

    await step('确认框按钮悬停不再上浮', async () => {
      await page.click('[data-testid="open-confirm"]')
      await page.waitForSelector('[role="dialog"], [role="alertdialog"]')
      await settle()
      const box = await page.evaluate(() => {
        const button = [...document.querySelectorAll('[data-modal-overlay] button')].find(b => b.textContent.trim() === '删除')
        const rect = button.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
      await page.waitForTimeout(200)
      await shot('confirm-hover')
      const transform = await page.evaluate(() => {
        const button = [...document.querySelectorAll('[data-modal-overlay] button')].find(b => b.textContent.trim() === '删除')
        return { hovered: button.matches(':hover'), transform: getComputedStyle(button).transform }
      })
      console.log('confirm hover', transform)
      assert.deepEqual(transform, { hovered: true, transform: 'none' })
      await page.evaluate(() => [...document.querySelectorAll('[data-modal-overlay] button')].find(b => b.textContent.trim() === '取消').click())
      await waitGhostsGone()
    })

    await step('应用内「减少动效」：关闭残影与入场动画，重载后保留', async () => {
      await page.evaluate(() => document.querySelector('button[aria-label="界面动效"]').click())
      await page.waitForSelector('[role="option"]')
      await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.includes('减少动效')).click())
      await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduce')
      await waitGhostsGone()
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:motion')), 'reduce')
      await page.reload()
      await page.waitForSelector('[data-testid="open-draft"]')
      assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'reduce')
      await page.click('[data-testid="open-draft"]')
      await page.waitForSelector('[data-testid="draft"]')
      await shot('reduced-dialog')
      const state = await page.evaluate(async () => {
        const panel = document.querySelector('.modal-content-enter')
        const duration = getComputedStyle(panel).animationDuration
        ;[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === '关闭').click()
        await new Promise(r => setTimeout(r, 10))
        return { duration, ghosts: document.querySelectorAll('[data-exit-ghost]').length }
      })
      console.log('reduced', state)
      assert.equal(state.ghosts, 0)
      assert.ok(parseFloat(state.duration) < 0.001, `入场动画被压到近乎 0：${state.duration}`)
      const reducedPage = await page.evaluate(async () => {
        document.querySelector('[data-testid="view-search"]').click()
        await new Promise(r => setTimeout(r, 10))
        const viewDuration = getComputedStyle(document.querySelector('[data-testid="sidebar-view"]')).animationDuration
        document.querySelector('[data-testid="toggle-search"]').click()
        await new Promise(r => setTimeout(r, 30))
        document.querySelector('[data-testid="toggle-search"]').click()
        await new Promise(r => setTimeout(r, 10))
        return { viewDuration, ghosts: document.querySelectorAll('[data-exit-ghost]').length }
      })
      console.log('reduced page switch', reducedPage)
      assert.ok(parseFloat(reducedPage.viewDuration) < 0.001, `换页入场被压到近乎 0：${reducedPage.viewDuration}`)
      assert.equal(reducedPage.ghosts, 0, '减少动效时浮条不留残影')
      await shot('settings-reduced')
    })

    await step('切回跟随系统后恢复退出动画', async () => {
      await page.evaluate(() => document.querySelector('button[aria-label="界面动效"]').click())
      await page.waitForSelector('[role="option"]')
      await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.includes('跟随系统')).click())
      await page.waitForFunction(() => document.documentElement.dataset.motion === undefined)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:motion')), null)
      await waitGhostsGone()
      await page.click('[data-testid="open-draft"]')
      await page.waitForSelector('[data-testid="draft"]')
      await settle()
      await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === '关闭').click())
      await page.waitForTimeout(10)
      assert.equal(await ghostCount(), 1)
      await waitGhostsGone()
    })
  } finally {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results }, null, 2))
    await task.finish?.()
  }
  return results
}
