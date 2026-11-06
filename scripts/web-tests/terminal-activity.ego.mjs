import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 终端标签运行状态：默认关闭不轮询；开启后两种状态点、查看后清除、关闭后停止。 */
export async function run({ spaceId, screenshots = true, artifactDir } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests', `terminal-activity-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode terminal activity indicator 20261105')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
  const clickButton = name => page.click(`loc=role:button[name="${name}"]`, { label: name })
  const probes = () => page.evaluate(() =>
    window.__QINGCODE_TEST__.calls().filter(call => call === 'terminal_child_process_states').length)
  const terminalIds = () => page.evaluate(() => window.__QINGCODE_TEST__.terminalIds())
  const title = (id, text) => page.evaluate(([terminal, value]) =>
    window.__QINGCODE_TEST__.output(terminal, `\x1b]0;${value}\x07`), [id, text])
  /** 第 index 个标签当前的状态点，没有则为 null。 */
  const phaseOf = index => page.evaluate(i => {
    const tab = document.querySelectorAll('[role="tab"]')[i]
    return tab?.querySelector('[data-terminal-activity]')?.dataset.terminalActivity ?? null
  }, index)
  const waitPhase = (index, phase) => page.waitForFunction(([i, expected]) => {
    const tab = document.querySelectorAll('[role="tab"]')[i]
    return (tab?.querySelector('[data-terminal-activity]')?.dataset.terminalActivity ?? null) === expected
  }, [index, phase], { timeout: 12000 })
  const setIndicator = async value => {
    await clickButton('设置')
    await page.waitForSelector('.settings-shell')
    await page.fill('.settings-shell input[type="search"], .settings-shell input', 'tabActivityIndicator')
    await page.waitForSelector('select[aria-label="终端 › 集成: 标签运行状态"]')
    await page.selectOption('select[aria-label="终端 › 集成: 标签运行状态"]', value)
    await page.waitForFunction(selected =>
      document.querySelector('select[aria-label="终端 › 集成: 标签运行状态"]').value === selected, value)
  }
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    // 否则后台窗口的 document.hasFocus() 为 false，所有标签都算「未查看」。
    await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page.goto(`http://127.0.0.1:38419/?testSession=terminal-activity-${Date.now()}`)
    await page.waitForFunction(() => Boolean(window.__QINGCODE_TEST__ && document.querySelector('button[aria-label="设置"]')))
    await clickButton('打开项目')
    await clickButton('信任并继续')
    await page.waitForSelector('[role="tab"]', { timeout: 15000 }).catch(() => clickButton('新建终端'))
    await page.waitForSelector('[role="tab"]')
    await clickButton('新建终端')
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 2)
    const [first, second] = await terminalIds()
    await page.waitForFunction(() => Boolean(document.querySelector('[role="tab"][aria-selected="true"]')))

    await step('off by default: no dots and no process polling', async () => {
      await title(first, '⠋ 后台任务')
      await page.waitForTimeout(6000)
      assert.equal(await probes(), 0)
      assert.equal(await phaseOf(0), null)
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-terminal-activity]').length), 0)
    })

    await setIndicator('on')
    await clickButton('资源管理器').catch(() => {})
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"]')
      tabs[tabs.length - 1]?.click()
    })

    await step('enabling starts polling and a background agent shows running', async () => {
      await page.waitForFunction(() =>
        window.__QINGCODE_TEST__.calls().includes('terminal_child_process_states'), null, { timeout: 12000 })
      await title(first, '⠙ 后台任务')
      await waitPhase(0, 'running')
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'running.png') })

    await step('an idle tab still reserves the status slot', async () => {
      const width = await page.evaluate(() => document.querySelectorAll('[role="tab"]')[1].offsetWidth)
      assert.ok(width > 0)
      assert.equal(await phaseOf(1), null)
      assert.equal(await page.evaluate(() =>
        document.querySelectorAll('[role="tab"]')[1].querySelectorAll('span.w-3').length), 1)
    })

    await step('background agent stopping becomes unseen after the hold window', async () => {
      await page.waitForTimeout(3500)
      await title(first, '✳ 后台任务')
      await waitPhase(0, 'unseen')
    })
    if (screenshots) await page.screenshot({ path: resolve(output, 'unseen.png') })

    await step('viewing the tab clears unseen without waiting for the next poll', async () => {
      await page.evaluate(() => document.querySelectorAll('[role="tab"]')[0].click())
      await page.waitForFunction(() =>
        !document.querySelectorAll('[role="tab"]')[0].querySelector('[data-terminal-activity]'),
        null, { timeout: 2000 })
    })

    await step('a viewed tab that finishes stays unmarked', async () => {
      await title(first, '⠹ 后台任务')
      await waitPhase(0, 'running')
      await page.waitForTimeout(3500)
      await title(first, '✳ 后台任务')
      await waitPhase(0, null)
    })

    await step('a background one that exits is unseen, then turning off removes dots and polling', async () => {
      await title(second, '⠸ 第二个任务')
      await waitPhase(1, 'running')
      await page.waitForTimeout(3500)
      await page.evaluate(id => window.__QINGCODE_TEST__.exit(id, 1), second)
      await waitPhase(1, 'unseen')
      await setIndicator('off')
      await page.waitForFunction(() => !document.querySelector('[data-terminal-activity]'), null, { timeout: 3000 })
      const before = await probes()
      await page.waitForTimeout(6000)
      assert.equal(await probes(), before)
    })
    await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify({ output, results }, null, 2))
    return results
  } catch (error) {
    if (screenshots) await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, error: String(error) }, null, 2))
    console.log(JSON.stringify({ output, results, error: String(error) }, null, 2))
    throw error
  }
}
