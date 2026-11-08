import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 安卓后台提醒入口、点通知进入会话、Unicode 11 宽度、WebGL 渲染回退与首次手势说明。
// 真实 Web 资产 + 内存桥：不覆盖前台服务、系统通知和息屏行为，这些必须真机验收。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-background-alerts')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode Android background alerts 20261105')
  const page = task.page('p1')
  const results = []
  const screenshots = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  const capture = async name => {
    try {
      await Promise.race([
        page.screenshot({ path: resolve(output, name + '.png') }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 15000)),
      ])
      screenshots.push({ name, saved: true })
    } catch (error) {
      screenshots.push({ name, saved: false, error: String(error.message ?? error) })
    }
  }
  const open = async query => {
    await page.goto(`${baseUrl}/mobile-android/?${query}`)
    await page.waitForFunction(() => typeof window.qingLink === 'function')
    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764)))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair fixture computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')
    await page.click('#dashboard-nav [data-page="project"]', { label: 'browse fixture projects' })
    await page.click('#project-list > :first-child .project-row:first-child .row', { label: 'open terminal project' })
    await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
    await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
  }
  const setBusy = busy => page.evaluate(value => {
    const fixture = window.__mobileFixture
    const session = [...fixture.state.sessions.values()].at(-1)
    session.programBusy = value
    session.activityRevision = (session.activityRevision ?? 0) + 1
  }, busy)
  const dismissTip = () => page.evaluate(() => document.querySelector('#input-tip-dismiss').click())

  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.goto(`${baseUrl}/mobile-android/`)
    await page.evaluate(() => { localStorage.clear() })

    await step('手势说明只在第一次接入终端时显示', async () => {
      await open('guide=1')
      assert.equal(await page.evaluate(() => document.querySelector('#gesture-guide').open), true)
      assert.match(await page.evaluate(() => document.querySelector('#gesture-guide').textContent), /双指缩放/)
      await capture('gesture-guide-390')
      await page.click('#gesture-guide [data-close]', { label: 'dismiss gesture guide' })
      await page.waitForFunction(() => localStorage.getItem('qingcode:mobile:gesture-guide-seen') === 'true')
      await open('guide=keep')
      assert.equal(await page.evaluate(() => document.querySelector('#gesture-guide').open), false)
    })

    await step('手势说明在 320px 下不溢出，返回键可关闭', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true })
      await open('guide=1')
      const layout = await page.evaluate(() => {
        const box = document.querySelector('#gesture-guide').getBoundingClientRect()
        const button = document.querySelector('#gesture-guide [data-close]').getBoundingClientRect()
        return { overflow: document.documentElement.scrollWidth > innerWidth, inside: box.left >= 0 && box.right <= innerWidth + 0.5, tall: button.height >= 44 }
      })
      assert.deepEqual(layout, { overflow: false, inside: true, tall: true })
      await capture('gesture-guide-320')
      assert.equal(await page.evaluate(() => window.qingBack()), true)
      assert.equal(await page.evaluate(() => document.querySelector('#gesture-guide').open), false)
      await page.waitForFunction(() => localStorage.getItem('qingcode:mobile:gesture-guide-seen') === 'true')
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    })

    await step('emoji 按 Unicode 11 占两格', async () => {
      await open('')
      const cell = await page.evaluate(() => new Promise(done => {
        const term = window.__mobileFixture.terminal()
        term.write('\r\n😀x', () => {
          const buffer = term.buffer.active
          const line = buffer.getLine(buffer.cursorY + buffer.baseY)
          done({ version: term.unicode.activeVersion, width: line.getCell(0).getWidth(), next: line.getCell(2).getChars() })
        })
      }))
      assert.deepEqual(cell, { version: '11', width: 2, next: 'x' })
    })

    await step('WebGL 可开关，丢失上下文后退回 DOM 并在回到前台时恢复', async () => {
      await open('gpu=1')
      const canvas = () => page.evaluate(() => !!document.querySelector('.xterm-screen canvas'))
      const supported = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))
      results.push({ name: 'webgl2 可用', passed: true, supported })
      if (!supported) {
        assert.equal(await canvas(), false)
        return
      }
      await page.waitForFunction(() => !!document.querySelector('.xterm-screen canvas'))
      await capture('webgl-terminal')
      await page.evaluate(() => {
        const select = document.querySelector('#terminal-renderer')
        select.value = 'off'
        select.dispatchEvent(new Event('change'))
      })
      await page.waitForFunction(() => !document.querySelector('.xterm-screen canvas'))
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:gpu-render')), 'off')
      await page.evaluate(() => {
        const select = document.querySelector('#terminal-renderer')
        select.value = 'on'
        select.dispatchEvent(new Event('change'))
      })
      await page.waitForFunction(() => !!document.querySelector('.xterm-screen canvas'))
      // 模拟系统挂起时丢失上下文：addon 等待约 3 秒未恢复后才通知。
      await page.evaluate(() => {
        // WebGL 渲染还带一个 2D 链接层画布，要找到真正的 WebGL 上下文。
        const gl = [...document.querySelectorAll('.xterm-screen canvas')].map(item => item.getContext('webgl2')).find(Boolean)
        gl.getExtension('WEBGL_lose_context').loseContext()
      })
      await page.waitForFunction(() => !document.querySelector('.xterm-screen canvas'), undefined, { timeout: 10000 })
      // 退回 DOM 后文字必须重新画出来，不能留下空白终端。
      await page.evaluate(() => window.__mobileFixture.terminal().write('after-context-loss'))
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('after-context-loss'))
      await page.evaluate(() => window.qingVisibility(true))
      await page.waitForFunction(() => !!document.querySelector('.xterm-screen canvas'))
    })

    await step('第一次看到程序运行时询问一次，开启后写入设置', async () => {
      await open('')
      await page.evaluate(() => {
        localStorage.removeItem('qingcode:mobile:session-watch')
        window.__mobileFixture.state.capabilities.features.push('attention')
      })
      await dismissTip()
      await setBusy(true)
      await page.waitForFunction(() => !document.querySelector('#watch-tip').hidden)
      await capture('watch-tip')
      await page.click('#watch-tip-enable', { label: 'enable background alerts' })
      await page.waitForFunction(() => window.__mobileFixture.state.sessionWatch?.enabled === true)
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:session-watch')), 'on')
      assert.equal(await page.evaluate(() => document.querySelector('#session-watch').value), 'on')
      assert.equal(await page.evaluate(() => document.querySelector('#watch-tip').hidden), true)
    })

    await step('答过之后不再询问；重启后仍同步设置到原生层', async () => {
      await open('')
      assert.equal(await page.evaluate(() => window.__mobileFixture.state.sessionWatch.enabled), true)
      await page.evaluate(() => window.__mobileFixture.state.capabilities.features.push('attention'))
      await dismissTip()
      await setBusy(true)
      await new Promise(done => setTimeout(done, 1500))
      assert.equal(await page.evaluate(() => document.querySelector('#watch-tip').hidden), true)
    })

    await step('拒绝通知权限时保持关闭并提示', async () => {
      await page.evaluate(() => {
        window.__mobileFixture.state.notificationsAllowed = false
        const select = document.querySelector('#session-watch')
        select.value = 'off'
        select.dispatchEvent(new Event('change'))
      })
      await page.waitForFunction(() => window.__mobileFixture.state.sessionWatch?.enabled === false)
      await page.evaluate(() => {
        const select = document.querySelector('#session-watch')
        select.value = 'on'
        select.dispatchEvent(new Event('change'))
      })
      await page.waitForFunction(() => document.querySelector('#font-toast').textContent.includes('通知权限'))
      assert.equal(await page.evaluate(() => document.querySelector('#session-watch').value), 'off')
      assert.equal(await page.evaluate(() => localStorage.getItem('qingcode:mobile:session-watch')), 'off')
    })

    await step('旧版电脑不询问', async () => {
      await open('')
      await page.evaluate(() => localStorage.removeItem('qingcode:mobile:session-watch'))
      await dismissTip()
      await setBusy(true)
      await new Promise(done => setTimeout(done, 1500))
      assert.equal(await page.evaluate(() => document.querySelector('#watch-tip').hidden), true)
    })

    await step('点通知切到目标会话并清除它的通知；未配对的地址被忽略', async () => {
      await open('')
      const created = await page.evaluate(async () => {
        const fixture = window.__mobileFixture
        const first = [...fixture.state.sessions.keys()].at(-1)
        document.querySelector('#new-session').click()
        for (let i = 0; i < 200 && !document.querySelector('#terminal-profiles button[data-profile="default"]'); i += 1) {
          await new Promise(done => setTimeout(done, 20))
        }
        document.querySelector('#terminal-profiles button[data-profile="default"]').click()
        for (let i = 0; i < 200 && [...fixture.state.sessions.keys()].at(-1) === first; i += 1) {
          await new Promise(done => setTimeout(done, 20))
        }
        return { first, second: [...fixture.state.sessions.keys()].at(-1), project: fixture.state.sessions.get(first).project }
      })
      assert.notEqual(created.first, created.second)
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await page.evaluate(() => { window.__mobileFixture.state.sessionWatchSeen = []; window.__mobileFixture.state.polls = [] })
      await page.evaluate(target => window.qingOpenSession({ address: '10.9.9.9:1', project: target.project, session: target.first }), created)
      await new Promise(done => setTimeout(done, 300))
      assert.deepEqual(await page.evaluate(() => window.__mobileFixture.state.sessionWatchSeen), [])
      await page.evaluate(target => window.qingOpenSession({ address: '192.168.1.8:48764', project: target.project, session: target.first }), created)
      await page.waitForFunction(id => window.__mobileFixture.state.sessionWatchSeen.includes(id), created.first)
      await page.waitForFunction(id => window.__mobileFixture.state.polls.at(-1)?.id === id, created.first)
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots, nativeAndroid: false }, null, 2))
    console.log({ output, results, screenshots })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, screenshots, error: String(error?.stack ?? error), spaceId: task.spaceId }, null, 2))
    console.log({ output, spaceId: task.spaceId, results })
    throw error
  }
}
