import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 终端工作台面板布局：完整 App + 内存后端（pnpm dev:web-test，端口 38419）。
 * 进入预设、列表操作、编辑器按需展开与宽度分隔条、收起、重载恢复、切回其他预设、窄窗。
 * 终端与文件均为模拟，不代替 Tauri 下真实 PTY、SSH 与原生窗口验收。
 */
export async function run({ spaceId, screenshots = true, artifactDir } = {}) {
  const output = artifactDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.dev/web-tests/terminal-workbench')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal workbench 20261108')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => {
    try {
      await work()
      results.push({ name, status: 'passed' })
    } catch (error) {
      results.push({ name, status: 'failed', error: String(error) })
      throw error
    }
  }
  const shot = async name => {
    if (!screenshots) return
    try {
      await page.screenshot({ path: resolve(output, `${name}.png`) })
    } catch (error) {
      results.push({ name: `screenshot ${name}`, status: 'skipped', error: String(error) })
    }
  }
  const button = name => `button[aria-label="${name}"]`
  const clickButton = (name, label = name) => page.click(button(name), { label })
  const waitFor = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 })
  const selectLayout = async name => {
    await clickButton('选择面板布局', 'open layout menu')
    await page.waitForSelector('[role="menu"]')
    await page.click(`loc=role:menuitemcheckbox[name="${name}"]`, { label: 'pick layout preset' })
    await waitFor(() => !document.querySelector('[role="menu"]'))
  }
  const layout = () => page.evaluate(() => {
    const rect = el => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
    }
    const grid = document.querySelector('.workspace-grid')
    const editor = document.querySelector('[data-editor-column]')
    return {
      panelLayout: grid.dataset.panelLayout,
      editorSlot: grid.dataset.editorSlot,
      split: grid.dataset.terminalSplit ?? null,
      list: rect(document.querySelector('[data-terminal-session-list]')),
      terminal: rect(document.querySelector('[data-terminal-panel]')),
      editor: getComputedStyle(editor).display === 'none' ? null : rect(editor),
      stripCount: document.querySelectorAll('[data-terminal-panel] [role="tablist"]').length,
      rows: [...document.querySelectorAll('[data-terminal-session-row]')].map(row => ({
        id: row.dataset.terminalSessionRow,
        selected: row.getAttribute('aria-selected') === 'true',
        text: row.textContent,
      })),
    }
  })
  const rowSelector = index => `[data-terminal-project-group]:nth-of-type(1) [role="tab"]:nth-child(${index})`

  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false })
    await page.goto(`http://127.0.0.1:38419/?testSession=terminal-workbench-${Date.now()}`)
    await page.evaluate(() => { localStorage.removeItem('qingcode:panel-layout'); localStorage.removeItem('qingcode:terminal-panel') })
    await page.reload()
    await waitFor(() => Boolean(window.__QINGCODE_TEST__ && document.querySelector('button[aria-label="设置"]')))
    await page.click('loc=role:button[name="打开项目"]', { label: 'open demo project' })
    await page.click('loc=role:button[name="信任并继续"]', { label: 'trust demo project' })
    await waitFor(() => document.body.textContent.includes('README.md'))

    await step('菜单提供终端工作台，进入后左侧为列表、编辑器收起、无横向标签栏', async () => {
      await selectLayout('终端工作台（左侧列表）')
      await page.waitForSelector('[data-terminal-session-list]')
      const state = await layout()
      assert.equal(state.panelLayout, 'terminalWorkbench')
      assert.equal(state.editorSlot, 'collapsed')
      assert.equal(state.editor, null)
      assert.equal(state.stripCount, 0)
      assert.ok(state.list.right <= state.terminal.left + 1, '列表应在终端左侧')
      const pressed = await page.evaluate(() => document.querySelector('button[aria-label="终端列表"]').getAttribute('aria-pressed'))
      assert.equal(pressed, 'true')
    })

    await step('标题栏只保留编辑器开关，不出现双/四终端', async () => {
      const buttons = await page.evaluate(() => ({
        editor: !!document.querySelector('button[aria-label="显示编辑器"]'),
        dual: !!document.querySelector('button[aria-label="开启双终端"]'),
        quad: !!document.querySelector('button[aria-label="开启四终端"]'),
      }))
      assert.deepEqual(buttons, { editor: true, dual: false, quad: false })
    })

    await step('新建多个终端后逐行列出，新终端自动选中', async () => {
      const before = (await layout()).rows.length
      for (let i = 0; i < 3; i += 1) {
        const expected = before + i + 1
        await clickButton('新建终端', 'create terminal')
        await waitFor(count => document.querySelectorAll('[data-terminal-session-row]').length === count, expected)
      }
      const { rows } = await layout()
      assert.equal(rows.filter(row => row.selected).length, 1)
      assert.equal(rows.at(-1).selected, true)
    })
    await shot('list')

    await step('点击列表行切换终端', async () => {
      await page.click(rowSelector(1), { label: 'select first terminal' })
      await waitFor(() => document.querySelector('[data-terminal-session-list] [role="tab"]')?.getAttribute('aria-selected') === 'true')
      const visible = await page.evaluate(() => document.querySelectorAll('[data-terminal-panel] [data-terminal-pane="primary"]:not(.invisible)').length)
      assert.equal(visible, 1)
    })

    await step('方向键沿列表移动选中项', async () => {
      await page.focus(rowSelector(1))
      await page.keyboard.press('ArrowDown')
      await waitFor(() => document.querySelectorAll('[data-terminal-session-list] [role="tab"]')[1]?.getAttribute('aria-selected') === 'true')
    })

    await step('双击重命名', async () => {
      await page.dblclick(rowSelector(2), { label: 'rename terminal' })
      await page.waitForSelector('input[aria-label="重命名终端"]')
      await page.fill('input[aria-label="重命名终端"]', 'claude-工作')
      await page.keyboard.press('Enter')
      await waitFor(() => document.querySelector('[data-terminal-session-list]').textContent.includes('claude-工作'))
    })

    await step('关闭运行中的终端需要二次点击', async () => {
      const before = (await layout()).rows.length
      await page.click(`${rowSelector(1)} [data-terminal-close]`, { label: 'arm close' })
      assert.equal((await layout()).rows.length, before)
      await page.waitForSelector(`${rowSelector(1)} button[aria-label="确认关闭终端"]`)
      await page.click(`${rowSelector(1)} [data-terminal-close]`, { label: 'confirm close' })
      await waitFor(count => document.querySelectorAll('[data-terminal-session-row]').length === count, before - 1)
    })

    await step('添加第二个项目后按项目分组，当前项目置顶', async () => {
      await page.click('button[aria-label="添加项目"]', { label: 'open add project' })
      await page.waitForSelector('button[aria-label^="草稿项目"]')
      await page.click('button[aria-label^="草稿项目"]', { label: 'create draft project' })
      // 添加项目后默认看新项目的文件树，这里回到列表。
      await waitFor(() => document.body.textContent.includes('临时项目'))
      await clickButton('终端列表', 'back to terminal list')
      await waitFor(() => document.querySelectorAll('[data-terminal-project-group]').length === 2)
      await waitFor(() => document.querySelector('[data-terminal-project-group]').getAttribute('aria-current') === 'true')
      const empty = await page.evaluate(() => {
        const first = document.querySelector('[data-terminal-project-group]')
        return { rows: first.querySelectorAll('[role="tab"]').length, disabled: first.querySelector('button[aria-expanded], button:disabled') !== null }
      })
      assert.deepEqual(empty, { rows: 0, disabled: true })
    })

    await step('在分组标题新建终端', async () => {
      await page.hover('[data-terminal-project-group]:nth-of-type(1) > div', { label: 'hover project header' })
      await page.click('[data-terminal-project-group]:nth-of-type(1) button[aria-label^="在「"]', { label: 'new terminal in group' })
      await waitFor(() => document.querySelector('[data-terminal-project-group]').querySelectorAll('[role="tab"]').length === 1)
    })
    await shot('all-projects')

    const groupRow = (group, index = 1) => `[data-terminal-project-group]:nth-of-type(${group}) [role="tab"]:nth-child(${index})`
    const moveOutOfList = () => page.mouse.move(900, 400, { label: 'leave terminal list' })

    await step('点击其他项目的终端切换工作区，鼠标移出列表后才重排', async () => {
      const target = await page.evaluate(selector => document.querySelector(selector).dataset.terminalSessionRow, groupRow(2))
      await page.click(groupRow(2), { label: 'select other project terminal' })
      await waitFor(id => document.querySelector(`[data-terminal-session-row="${id}"]`).getAttribute('aria-selected') === 'true', target)
      const beforeLeave = await page.evaluate(() => [...document.querySelectorAll('[data-terminal-project-group]')].map(group => group.getAttribute('aria-current')))
      assert.deepEqual(beforeLeave, [null, 'true'], '鼠标在列表内时分组不移动')
      await moveOutOfList()
      await waitFor(() => document.querySelector('[data-terminal-project-group]').getAttribute('aria-current') === 'true')
      assert.equal(await page.evaluate(() => document.body.textContent.includes('README.md') || document.querySelector('[data-terminal-session-list]') !== null), true)
    })

    await step('后台项目的任务运行时亮点，结束后显示待查看，切过去后清除', async () => {
      const target = await page.evaluate(selector => document.querySelector(selector).dataset.terminalSessionRow, groupRow(2))
      // 持续输出约 1.5 秒，达到“运行中”的判定。
      await page.evaluate(async id => {
        for (let i = 0; i < 16; i += 1) {
          window.__QINGCODE_TEST__.output(id, `line ${i}\r\n`)
          await new Promise(done => setTimeout(done, 100))
        }
      }, target)
      await waitFor(id => document.querySelector(`[data-terminal-session-row="${id}"] [data-terminal-activity="running"]`) !== null, target)
      await waitFor(id => document.querySelector(`[data-terminal-session-row="${id}"] [data-terminal-activity="attention"]`) !== null, target)
      await shot('attention')
      await page.click(groupRow(2), { label: 'open finished terminal' })
      await waitFor(id => document.querySelector(`[data-terminal-session-row="${id}"]`).getAttribute('aria-selected') === 'true', target)
      assert.equal(await page.evaluate(id => document.querySelector(`[data-terminal-session-row="${id}"] [data-terminal-activity="attention"]`), target), null)
      await moveOutOfList()
      await waitFor(() => document.querySelector('[data-terminal-project-group]').getAttribute('aria-current') === 'true')
    })

    await step('折叠其他项目后行隐藏，再展开恢复', async () => {
      const toggle = '[data-terminal-project-group]:nth-of-type(2) button[aria-expanded]'
      await page.click(toggle, { label: 'collapse project' })
      await waitFor(() => document.querySelectorAll('[data-terminal-project-group]:nth-of-type(2) [role="tab"]').length === 0)
      await page.click(toggle, { label: 'expand project' })
      await waitFor(() => document.querySelectorAll('[data-terminal-project-group]:nth-of-type(2) [role="tab"]').length > 0)
      await moveOutOfList()
    })

    await step('回到有文件树的示例项目', async () => {
      const demo = await page.evaluate(() => [...document.querySelectorAll('[data-terminal-project-group]')].findIndex(group => group.querySelector('[role="tab"]') && group.getAttribute('aria-label') === 'demo') + 1)
      assert.ok(demo > 0, '应能找到示例项目分组')
      if (demo === 2) {
        await page.click(groupRow(2), { label: 'back to demo project' })
        await moveOutOfList()
      }
      await waitFor(() => document.querySelector('[data-terminal-project-group]').getAttribute('aria-label') === 'demo')
    })

    await step('切到文件树时列表隐藏、横向标签栏接管切换', async () => {
      await clickButton('资源管理器', 'show file tree')
      await waitFor(() => !document.querySelector('[data-terminal-session-list]'))
      assert.equal((await layout()).stripCount, 1)
    })

    await step('打开文件后编辑器在终端右侧展开', async () => {
      await page.evaluate(() => {
        const target = [...document.querySelectorAll('.workspace-grid-sidebar *')].find(el => el.children.length === 0 && el.textContent === 'README.md')
        target.click()
      })
      await waitFor(() => document.querySelector('.workspace-grid').dataset.editorSlot === 'visible')
      await clickButton('终端列表', 'back to terminal list')
      await page.waitForSelector('[data-terminal-session-list]')
      const state = await layout()
      assert.ok(state.editor, '编辑器应可见')
      assert.ok(state.terminal.right <= state.editor.left + 1, '编辑器应在终端右侧')
      assert.ok(state.list.right <= state.terminal.left + 1, '列表应紧邻终端')
      assert.ok(Math.abs(state.terminal.width - state.editor.width) <= 2, '默认 1:1')
    })
    await shot('with-editor')

    await step('分隔条向右拖动使终端变宽，且开合编辑器后保留宽度', async () => {
      const before = await layout()
      const x = before.terminal.right - 2
      await page.mouse.move(x, 400, { label: 'grab terminal sash' })
      await page.mouse.down()
      await page.mouse.move(x + 150, 400, { steps: 8, label: 'drag sash right' })
      await page.mouse.up()
      await waitFor(() => document.querySelector('.workspace-grid').dataset.terminalSplit === 'custom')
      const after = await layout()
      assert.ok(after.terminal.width > before.terminal.width + 100, `终端应变宽：${before.terminal.width} → ${after.terminal.width}`)
      assert.ok(after.terminal.right <= after.editor.left + 1, '拖动后列序不变')
      await clickButton('隐藏编辑器', 'hide editor')
      await waitFor(() => document.querySelector('.workspace-grid').dataset.editorSlot === 'collapsed')
      await clickButton('显示编辑器', 'show editor')
      await waitFor(() => document.querySelector('.workspace-grid').dataset.editorSlot === 'visible')
      assert.equal((await layout()).split, 'custom')
    })

    await step('关闭最后一个编辑器标签后收起编辑器', async () => {
      await page.evaluate(() => document.querySelector('[aria-label="关闭文件"]').click())
      await waitFor(() => document.querySelector('.workspace-grid').dataset.editorSlot === 'collapsed')
      // 终端列宽有 200ms 过渡，等动画结束后再比较。
      await waitFor(() => {
        const list = document.querySelector('[data-terminal-session-list]').getBoundingClientRect()
        const terminal = document.querySelector('[data-terminal-panel]').getBoundingClientRect()
        return Math.abs(terminal.left - list.right) <= 8 && Math.abs(terminal.right - innerWidth) <= 1
      })
      assert.equal((await layout()).editor, null)
    })

    await step('切到没有打开文件的项目时收起编辑器', async () => {
      await clickButton('资源管理器', 'show file tree')
      await page.evaluate(() => {
        const target = [...document.querySelectorAll('.workspace-grid-sidebar *')].find(el => el.children.length === 0 && el.textContent === 'README.md')
        target.click()
      })
      await waitFor(() => document.querySelector('.workspace-grid').dataset.editorSlot === 'visible')
      await clickButton('终端列表', 'back to terminal list')
      await page.waitForSelector('[data-terminal-session-list]')
      await page.click('[data-terminal-project-group]:nth-of-type(2) [role="tab"]:nth-child(1)', { label: 'switch to project without files' })
      await waitFor(() => document.querySelector('.workspace-grid').dataset.editorSlot === 'collapsed')
      await page.click('[data-terminal-project-group]:nth-of-type(1) [role="tab"]:nth-child(1)', { label: 'back to demo project' })
      await waitFor(() => document.querySelector('[data-terminal-project-group]:nth-of-type(1)').getAttribute('aria-current') === 'true')
      assert.equal(await page.evaluate(() => document.querySelector('.workspace-grid').dataset.editorSlot), 'collapsed', '切回时不抢终端宽度')
      await page.mouse.move(900, 400, { label: 'leave terminal list' })
      await clickButton('显示编辑器', 'show editor')
      await waitFor(() => document.querySelector('[aria-label="关闭文件"]'))
      await page.evaluate(() => document.querySelector('[aria-label="关闭文件"]').click())
      await waitFor(() => document.querySelector('.workspace-grid').dataset.editorSlot === 'collapsed')
    })

    await step('收起终端后点列表行重新展开', async () => {
      await clickButton('收起终端', 'collapse terminal')
      await waitFor(() => document.querySelector('.workspace-grid').dataset.terminalSlot === 'collapsed')
      await page.click(rowSelector(1), { label: 'reopen terminal from list' })
      await waitFor(() => document.querySelector('.workspace-grid').dataset.terminalSlot === 'visible')
    })

    await step('重载后恢复工作台与列表视图', async () => {
      await page.reload()
      await page.waitForSelector('[data-terminal-session-list]')
      assert.equal((await layout()).panelLayout, 'terminalWorkbench')
      // 启动闪屏盖在界面上，等它消失后后面的截图才有意义。
      await waitFor(() => !document.getElementById('startup-splash'))
    })

    await step('800px 窄窗无横向溢出，列表可用', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false })
      await waitFor(() => window.innerWidth === 800)
      const overflow = await page.evaluate(() => {
        const list = document.querySelector('[data-terminal-session-list]')
        return { page: document.documentElement.scrollWidth - innerWidth, list: list.scrollWidth - list.clientWidth }
      })
      assert.ok(overflow.page <= 1, `页面溢出 ${overflow.page}`)
      assert.ok(overflow.list <= 1, `列表溢出 ${overflow.list}`)
      await shot('narrow')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false })
    })

    await step('切回其他预设后列表与入口消失，回到资源管理器', async () => {
      await selectLayout('编辑器+双终端')
      await waitFor(() => !document.querySelector('[data-terminal-session-list]'))
      const state = await page.evaluate(() => ({
        layout: document.querySelector('.workspace-grid').dataset.panelLayout,
        listEntry: !!document.querySelector('button[aria-label="终端列表"]'),
        explorer: document.querySelector('button[aria-label="资源管理器"]').getAttribute('aria-pressed'),
        dualPanes: document.querySelectorAll('[data-terminal-pane]').length,
      }))
      assert.deepEqual(state, { layout: 'sideTerminal', listEntry: false, explorer: 'true', dualPanes: 2 })
    })
    await shot('back-to-dual')

    await step('可重新进入工作台，并切回经典布局', async () => {
      await selectLayout('终端工作台（左侧列表）')
      await page.waitForSelector('[data-terminal-session-list]')
      await selectLayout('经典布局（终端在底部）')
      await waitFor(() => document.querySelector('.workspace-grid').dataset.panelLayout === 'classic')
    })
    // 成功后关闭自己的 TaskSpace；失败时保留现场。传入 spaceId 表示由调用方继续使用。
    if (!spaceId) await task.finish({ keep: [] })
  } finally {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeIntegration: false, spaceId: task.spaceId, results }, null, 2))
    console.log(JSON.stringify({ output, spaceId: task.spaceId, results }, null, 2))
  }
}
