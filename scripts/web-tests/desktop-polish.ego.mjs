import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 电脑端界面打磨验收（DESIGN.md「控件基准」）：复用完整 App 与业务 Store，按深色 / 浅色截取
 * 空编辑页、设置、四终端、终端工作台、项目管理与远程连接弹窗，并断言打磨后的结构约定：
 * 活动栏视图与动作分组、标题栏不重复品牌字、多格终端只有聚焦格显示快捷键栏、格内标签只留图标、
 * 设置页范围切换与搜索同一行、设置下拉宽度一致、弹窗按四档宽度、按钮共用 `btn` 基准。
 * 先启动 `pnpm dev:web-test`（38419），用 headless-task-space.mjs 运行；`run({ baseline: true })` 只截图不断言。
 */
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38419', artifactDir, baseline = false } = {}) {
  const task = await taskSpace(spaceId ?? 'QingCode desktop polish')
  const page = task.page('p1')
  const output = artifactDir ?? resolve(repo, `.dev/web-tests/desktop-polish${baseline ? '-baseline' : ''}`)
  await mkdir(output, { recursive: true })
  const results = []
  const step = async (name, action) => {
    await action()
    results.push({ name, status: 'passed' })
    console.log(`PASS ${name}`)
  }
  const check = (name, action) => (baseline ? Promise.resolve() : step(name, action))
  const shot = name => page.screenshot({ path: resolve(output, `${name}.png`) })
  const settle = (ms = 450) => page.waitForTimeout(ms)
  const clickByName = name => page.evaluate(label => {
    const element = [...document.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"]')]
      .find(item => item.getClientRects().length && ((item.getAttribute('aria-label') ?? item.textContent ?? '').trim() === label))
    if (!element) throw new Error(`找不到按钮：${label}`)
    element.click()
    return true
  }, name)
  const ui = (method, ...args) => page.evaluate(async ([name, params]) => {
    const { useUIStore } = await import('/src/store/uiStore.ts')
    useUIStore.getState()[name](...params)
    return true
  }, [method, args])
  const setTheme = theme => page.evaluate(async value => {
    const { applyTheme, saveTheme } = await import('/src/lib/themeSettings.ts')
    saveTheme(value)
    applyTheme(value)
    return true
  }, theme)

  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await page.goto(`${baseUrl}/?testSession=desktop-polish-${Date.now()}`)
    await page.waitForFunction(() => Boolean(window.__QINGCODE_TEST__ && document.querySelector('button[aria-label="设置"]')))
    await clickByName('打开项目')
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(item => item.textContent.trim() === '信任并继续'))
    await clickByName('信任并继续')
    await page.waitForFunction(async () => {
      const { useProjectStore } = await import('/src/store/projectStore.ts')
      return Boolean(useProjectStore.getState().currentProject)
    })
    await settle()

    // 预先在四终端布局的每一格各建一个终端，供四终端与工作台截图使用。
    await page.evaluate(async () => {
      const { useProjectStore } = await import('/src/store/projectStore.ts')
      const { useTerminalStore } = await import('/src/store/terminalStore.ts')
      const { useUIStore } = await import('/src/store/uiStore.ts')
      const { TERMINAL_FOCUS_PANES } = await import('/src/store/terminal/panes.ts')
      useUIStore.getState().setPanelLayoutMode('sideDualEditor')
      if (!useUIStore.getState().sideQuadTerminal) useUIStore.getState().toggleSideQuadTerminal()
      const project = useProjectStore.getState().currentProject ?? useProjectStore.getState().projects[0]
      for (const pane of TERMINAL_FOCUS_PANES) {
        useTerminalStore.getState().setTerminalFocusPane(pane)
        await useTerminalStore.getState().addTerminal(project.path, project.id)
      }
      useTerminalStore.getState().setTerminalFocusPane(TERMINAL_FOCUS_PANES[0])
      return true
    })
    await page.waitForFunction(() => window.__QINGCODE_TEST__.terminalIds().length >= 4)
    await page.evaluate(() => {
      const ids = window.__QINGCODE_TEST__.terminalIds()
      ids.forEach((id, index) => window.__QINGCODE_TEST__.output(id, `PS D:\\workspace\\demo> git log --oneline -3\r\n3dda712 feat: 终端 ${index + 1}\r\nb77bff8 feat: desktop history\r\nPS D:\\workspace\\demo> `))
      return true
    })

    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await ui('setPanelLayoutMode', 'classic')
      await ui('setView', 'explorer')
      await settle()
      await shot(`${theme}-01-classic`)

      await clickByName('设置')
      await page.waitForSelector('.settings-shell')
      await settle()
      await shot(`${theme}-02-settings`)

      await ui('setPanelLayoutMode', 'sideDualEditor')
      await ui('setView', 'explorer')
      await settle()
      await page.evaluate(async () => {
        const { useUIStore } = await import('/src/store/uiStore.ts')
        const state = useUIStore.getState()
        if (!state.sideQuadTerminal) state.toggleSideQuadTerminal()
        if (useUIStore.getState().sideEditorVisible) useUIStore.getState().toggleSideEditorVisible()
        return true
      })
      await settle(700)
      await shot(`${theme}-03-quad-terminals`)

      await ui('setPanelLayoutMode', 'terminalWorkbench')
      await settle(700)
      await shot(`${theme}-04-workbench`)

      await ui('openProjectManager')
      await settle()
      await shot(`${theme}-05-project-manager`)
      await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await settle()

      await ui('openRemoteConnections')
      await settle()
      await shot(`${theme}-06-remote-connections`)
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      await settle()
      await ui('setPanelLayoutMode', 'classic')
      await settle()
    }

    await setTheme('dark')
    await ui('setPanelLayoutMode', 'classic')
    await settle()

    await check('活动栏视图在上、动作与设置分组靠下，收起按钮在最底部', async () => {
      const layout = await page.evaluate(() => {
        const bar = document.querySelector('[data-activity-bar]')
        const groups = [...bar.querySelectorAll('[data-activity-group]')].map(group => group.dataset.activityGroup)
        const labels = group => [...bar.querySelectorAll(`[data-activity-group="${group}"] button[aria-label]`)].map(item => item.getAttribute('aria-label'))
        const last = [...bar.querySelectorAll('button[aria-label]')].at(-1)?.getAttribute('aria-label')
        return { groups, views: labels('views'), actions: labels('actions'), footer: labels('footer'), last }
      })
      assert.deepEqual(layout.groups, ['views', 'actions', 'footer'])
      assert.deepEqual(layout.views, ['资源管理器', '搜索', '源代码管理', '运行配置'])
      assert.deepEqual(layout.actions, ['新建项目', '项目管理', '远程连接', '显示或隐藏终端'])
      assert.deepEqual(layout.footer, ['设置', '向左收起活动栏'])
    })

    await check('标题栏不再重复显示产品名', async () => {
      const text = await page.evaluate(() => document.querySelector('.title-bar-shell').innerText)
      assert.ok(!/QingCode/.test(text.replace(/demo/g, '')), text)
    })

    await check('设置页范围切换、搜索和管理入口在同一行，下拉宽度一致', async () => {
      await clickByName('设置')
      await page.waitForSelector('.settings-shell')
      await settle()
      const state = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect()
        const scope = box('[data-settings-toolbar] [role="tablist"]')
        const search = box('[data-settings-toolbar] input[placeholder="搜索设置"]')
        const more = box('[data-settings-toolbar] button[aria-label="管理设置"]')
        const widths = [...document.querySelectorAll('.settings-item-control > .setting-control')]
          .filter(item => item.getClientRects().length)
          .map(item => Math.round(item.getBoundingClientRect().width))
        return { rows: [scope, search, more].map(item => Math.round(item.top + item.height / 2)), widths }
      })
      assert.ok(Math.max(...state.rows) - Math.min(...state.rows) <= 2, JSON.stringify(state.rows))
      assert.ok(state.widths.length >= 4, JSON.stringify(state.widths))
      assert.equal(new Set(state.widths).size, 1, JSON.stringify(state.widths))
    })

    await check('多格终端只在聚焦格显示快捷键栏，格内标签只留图标', async () => {
      await ui('setPanelLayoutMode', 'sideDualEditor')
      await ui('setView', 'explorer')
      await page.evaluate(async () => {
        const { useUIStore } = await import('/src/store/uiStore.ts')
        if (!useUIStore.getState().sideQuadTerminal) useUIStore.getState().toggleSideQuadTerminal()
        return true
      })
      await settle(700)
      const state = await page.evaluate(() => {
        const panes = [...document.querySelectorAll('[data-terminal-pane][data-terminal-pane-shell]')]
        return panes.map(pane => ({
          focused: pane.dataset.terminalActive === 'true',
          barOpacity: Number(getComputedStyle(pane.querySelector('.terminal-shortcut-bar')).opacity),
          barHeight: pane.querySelector('.terminal-shortcut-bar').getBoundingClientRect().height,
          label: pane.querySelector('[data-terminal-pane-title]').innerText.trim(),
        }))
      })
      assert.equal(state.length, 4, JSON.stringify(state))
      assert.equal(state.filter(pane => pane.focused).length, 1)
      for (const pane of state) {
        assert.equal(pane.barOpacity, pane.focused ? 1 : 0, JSON.stringify(pane))
        assert.ok(pane.barHeight > 0, '隐藏时保留高度，切换聚焦不改终端行数')
        assert.equal(pane.label, '')
      }
    })

    await check('弹窗宽度只用四档，按钮共用 btn 基准', async () => {
      await ui('openRemoteConnections')
      await settle()
      const state = await page.evaluate(() => {
        const panel = document.querySelector('[data-modal-overlay] .modal-panel')
        const buttons = [...document.querySelectorAll('[data-modal-overlay] button')]
          .filter(item => /bg-action/.test(item.className))
        return { size: panel && [...panel.classList].find(name => /^modal-(sm|md|lg|xl)$/.test(name)), legacy: buttons.length }
      })
      assert.ok(state.size, JSON.stringify(state))
      assert.equal(state.legacy, 0, '主操作按钮应使用 btn-primary')
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    })
  } finally {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ baseline, results }, null, 2))
    await task.finish?.()
  }
  return results
}
