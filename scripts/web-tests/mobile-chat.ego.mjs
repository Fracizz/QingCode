import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 手机聊天式 Agent 验收：真实 Android Web 资产 + web-tests/mobile-android-bridge.js 的内存 Agent 后端。
export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, finish = true } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, '.dev/web-tests/mobile-chat')
  await mkdir(output, { recursive: true })
  const task = await taskSpace(spaceId ?? 'QingCode mobile agent chat 20261104')
  const page = task.page('p1')
  const results = []
  const step = async (name, work) => { await work(); results.push({ name, passed: true }) }
  // 窗口被遮挡时页面不出新帧，page.screenshot() 会挂起：先拉到前台并重设视口再用 CDP 截图。
  const shot = async name => {
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    let capture
    for (let attempt = 0; attempt < 2 && !capture; attempt++) {
      await page.cdp('Page.bringToFront')
      await page.cdp('Emulation.setDeviceMetricsOverride', { ...metrics, deviceScaleFactor: 1, mobile: true })
      capture = await page.cdp('Page.captureScreenshot', { format: 'png' }, { timeout: 8000 }).catch(error => (attempt ? Promise.reject(error) : null))
    }
    await writeFile(resolve(output, name), Buffer.from(capture.data, 'base64'))
  }
  const portrait = () => page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  const text = selector => page.evaluate(selector => document.querySelector(selector)?.textContent ?? '', selector)
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
    && [...document.querySelectorAll('#chat-thread button, #chat-thread .chat-message, #chat-thread .chat-tool')].every(node => node.getBoundingClientRect().right <= innerWidth + 1))
  try {
    await portrait()
    await page.goto(baseUrl + '/mobile-android/')
    const bounds = await page.cdp('Browser.getWindowForTarget', {})
    if (bounds.bounds.windowState === 'minimized') await task.cdp('Browser.setWindowBounds', { windowId: bounds.windowId, bounds: { windowState: 'normal' } })
    await page.cdp('Page.bringToFront')
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key)
    })
    await page.reload()
    await portrait()

    await step('chat is the default page and offers pairing before a computer is connected', async () => {
      await page.waitForFunction(() => !document.querySelector('#chat-screen').hidden && document.querySelector('#chat-empty-title').textContent === '先连接一台电脑')
      assert.equal(await text('#dashboard-nav [aria-current="page"]'), '对话')
      await page.click('#chat-empty-action', { label: 'add first connection' })
      await page.waitForSelector('#pair-dialog[open]')
      await page.click('#pair-dialog [data-close]', { label: 'cancel pairing dialog' })
    })
    await shot('empty-unpaired.png')

    await page.evaluate(() => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764, undefined, '工作电脑')))
    await page.fill('#pair-code', 'A8z2D3')
    await page.click('#pair-submit', { label: 'pair test computer' })
    await page.waitForFunction(() => document.querySelector('#active-host').dataset.state === 'online')

    await step('paired computer shows an empty chat list and quota summary', async () => {
      await page.waitForFunction(() => document.querySelector('#chat-empty-title').textContent === '开始一段对话')
      await page.waitForFunction(() => document.querySelectorAll('#chat-quota .quota-cell').length === 3)
      assert.match(await text('#chat-quota'), /每周 42%/)
    })
    await shot('list-empty.png')

    await step('new chat dialog lists the three agents, chat-capable projects (local and Linux SSH) and the default safety option', async () => {
      await page.click('#chat-new', { label: 'start new chat' })
      await page.waitForSelector('#chat-new-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-new-providers .provider-choice').length), 3)
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#chat-new-project option')].map(option => option.value)), ['p-local', 'p-ssh'])
      await page.click('#chat-new-providers .provider-choice:first-child', { label: 'choose Claude' })
      assert.equal(await page.evaluate(() => document.querySelector('input[name="chat-new-safety"]:checked').value), 'default')
      await page.click('#chat-new-safety label[data-full="true"]', { label: 'preview full access' })
      await page.waitForFunction(() => !document.querySelector('#chat-new-full').hidden)
      await page.click('#chat-new-safety label:first-of-type', { label: 'back to ask every time' })
      await page.waitForFunction(() => document.querySelector('#chat-new-full').hidden)
    })
    await shot('new-dialog.png')

    await step('a conversation streams markdown, tool cards and a pending edit approval', async () => {
      await page.click('#chat-new-start', { label: 'create conversation' })
      await page.waitForFunction(() => !document.querySelector('#chat-thread').hidden && document.querySelector('#dashboard').hidden)
      await page.fill('#chat-input', '修复登录问题')
      await page.click('#chat-send', { label: 'send first message' })
      await page.waitForSelector('#chat-items .chat-approval[data-state="pending"]')
      assert.equal(await text('#chat-items .chat-message.user .bubble'), '修复登录问题')
      assert.match(await text('#chat-items .chat-message.assistant'), /好的，我来处理/)
      assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-items .code-block').length), 1)
      assert.match(await text('#chat-items .chat-tool[data-category="command"] .tool-title'), /ls src/)
      assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-items .chat-approval .diff-line[data-kind="add"]').length), 1)
      assert.match(await text('#chat-thread-sub'), /等待审批 1/)
      assert.equal(await page.evaluate(() => document.querySelector('#chat-send').dataset.mode), 'stop')
      assert.ok(await fits())
    })
    await shot('approval-pending.png')

    await step('approving finishes the turn with plan, summary and context usage', async () => {
      await page.click('#chat-items .chat-approval .approval-actions .primary', { label: 'allow file edit' })
      await page.waitForFunction(() => document.querySelector('#chat-items .chat-approval')?.dataset.state === 'resolved')
      await page.waitForFunction(() => /已修改/.test(document.querySelector('#chat-items').textContent) && document.querySelector('#chat-send').dataset.mode === 'send')
      assert.match(await text('#chat-items .chat-approval .approval-result'), /允许/)
      assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-items .chat-plan li').length), 3)
      assert.equal(await text('#chat-usage'), '上下文 12% · $0.024')
      await page.click('#chat-items .chat-message.assistant:last-child a', { label: 'open web link' })
      await page.waitForFunction(() => window.__mobileFixture.state.openedLinks.includes('https://example.com/docs'))
      await page.click('#chat-items .chat-tool[data-category="edit"] summary', { label: 'expand edit card' })
      assert.ok(await page.evaluate(() => document.querySelector('#chat-items .chat-tool[data-category="edit"]').open))
    })
    await shot('turn-complete.png')

    await step('switching to full access asks for confirmation and marks the chip', async () => {
      await page.click('#chat-safety', { label: 'open safety options' })
      await page.waitForSelector('#chat-options-dialog[open]')
      await page.click('#chat-options-safety label[data-full="true"]', { label: 'choose full access' })
      await page.waitForSelector('#confirm-dialog[open]')
      await page.click('#confirm-action', { label: 'confirm full access' })
      await page.waitForFunction(() => document.querySelector('#chat-safety').dataset.full === 'true')
      assert.equal(await text('#chat-safety-label'), '完全访问')
      await page.click('#chat-options-dialog [data-close]', { label: 'close options' })
    })

    await step('full access runs the next turn without asking on the phone', async () => {
      await page.fill('#chat-input', '再改一处')
      await page.click('#chat-send', { label: 'send second message' })
      await page.waitForFunction(() => document.querySelectorAll('#chat-items .chat-message.user').length === 2)
      await page.waitForFunction(() => document.querySelectorAll('#chat-items .chat-plan').length === 2 && document.querySelector('#chat-send').dataset.mode === 'send')
      assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-items .chat-approval').length), 1)
    })

    await step('narrow 320px conversation keeps cards and composer inside the screen', async () => {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true })
      await page.waitForTimeout(150)
      assert.ok(await fits())
      await shot('thread-320.png')
      await portrait()
    })

    await step('back returns to the list with the titled conversation', async () => {
      assert.equal(await page.evaluate(() => window.qingBack()), true)
      await page.waitForFunction(() => document.querySelector('#chat-thread').hidden && !document.querySelector('#chat-screen').hidden)
      await page.waitForFunction(() => document.querySelectorAll('#chat-list .chat-row').length === 1)
      assert.match(await text('#chat-list .chat-row'), /修复登录问题/)
      assert.match(await text('#chat-list .chat-row'), /Claude · QingCode/)
    })
    await shot('list-thread.png')

    await step('default safety options are saved per agent on the computer', async () => {
      await page.click('#chat-settings', { label: 'open default safety' })
      await page.waitForSelector('#chat-settings-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelectorAll('#chat-settings-list fieldset').length), 3)
      await page.click('#chat-settings-list fieldset:nth-child(2) label[data-full="true"]', { label: 'codex full by default' })
      await page.waitForFunction(() => window.__mobileFixture.state.agent.defaults.codex === 'full')
      await page.waitForFunction(() => /Codex 默认已保存/.test(document.querySelector('#chat-settings-status').textContent))
      await shot('default-safety.png')
      await page.click('#chat-settings-dialog [data-close]', { label: 'close default safety' })
    })

    await step('quota sheet shows windows, reset time and per-agent errors', async () => {
      await page.click('#chat-quota', { label: 'open quota sheet' })
      await page.waitForFunction(() => document.querySelectorAll('#chat-quota-list .quota-card').length === 3)
      const quota = await text('#chat-quota-list')
      assert.match(quota, /5 小时22%/)
      assert.match(quota, /后重置/)
      assert.match(quota, /Codex 未登录/)
      assert.match(quota, /提供方/)
      await shot('quota.png')
      await page.click('#chat-quota-dialog [data-close]', { label: 'close quota sheet' })
    })

    await step('project rows open terminals directly and offer chat; Linux SSH can chat, Windows remote stays terminal-only', async () => {
      await page.evaluate(() => window.__mobileFixture.state.projects.push({ id: 'p-win', name: 'win-api', path: 'ssh://conn-2/C:/work/api', kind: 'ssh', host: 'win.example' }))
      await page.click('#dashboard-nav [data-page="project"]', { label: 'browse projects' })
      await page.click('#refresh', { label: 'refresh projects' })
      await page.waitForFunction(() => document.querySelectorAll('#project-list .project-chat').length === 3)
      await page.click('#project-list .project-entry:nth-child(2) .project-chat', { label: 'chat with linux ssh project' })
      await page.waitForSelector('#chat-project-dialog[open]')
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('#chat-project-dialog [data-provider]')].every(button => !button.disabled)))
      assert.equal(await page.evaluate(() => document.querySelector('#chat-project-unsupported').hidden), true)
      await page.click('#chat-project-dialog [data-close]', { label: 'close project sheet' })
      await page.click('#project-list .project-entry:last-child .project-chat', { label: 'chat with windows remote' })
      await page.waitForSelector('#chat-project-dialog[open]')
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('#chat-project-dialog [data-provider]')].every(button => button.disabled)))
      assert.equal(await page.evaluate(() => document.querySelector('#chat-project-unsupported').hidden), false)
      await page.click('#chat-project-dialog [data-close]', { label: 'close windows sheet' })
      await page.click('#project-list .project-entry:first-child .project-chat', { label: 'chat with local project' })
      await page.click('#chat-project-dialog [data-provider="opencode"]', { label: 'new opencode chat' })
      await page.waitForSelector('#chat-new-dialog[open]')
      assert.equal(await page.evaluate(() => document.querySelector('input[name="chat-provider"]:checked').value), 'opencode')
      assert.equal(await page.evaluate(() => document.querySelector('#chat-new-project').value), 'p-local')
      await page.click('#chat-new-dialog [data-close]', { label: 'cancel new chat' })
      await page.click('#project-list .row:first-child .row-main', { label: 'open terminal project' })
      await page.waitForFunction(() => document.querySelector('#terminal-status').textContent === '会话中')
      await page.evaluate(() => window.qingBack())
      await page.waitForFunction(() => !document.querySelector('#project-screen').hidden)
    })

    await step('the open conversation is remembered for app restarts and cleared when leaving', async () => {
      // 内存桥在重载后会清空配对，这里只验证恢复依据的本地记录；真机重开由 Android 验收覆盖。
      await page.click('#dashboard-nav [data-page="chat"]', { label: 'back to chats' })
      await page.click('#chat-list .chat-row', { label: 'open conversation' })
      await page.waitForFunction(() => !document.querySelector('#chat-thread').hidden && document.querySelectorAll('#chat-items .chat-message.user').length === 2)
      const key = 'qingcode:mobile:chat-open:192.168.1.8:48764'
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'agent-1')
      await page.fill('#chat-input', '未发送的草稿')
      await page.evaluate(() => window.qingBack())
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null)
      await page.click('#chat-list .chat-row', { label: 'reopen conversation' })
      await page.waitForFunction(() => document.querySelector('#chat-input').value === '未发送的草稿')
      await page.evaluate(() => window.qingBack())
    })

    await step('older desktops without chat support get an update hint', async () => {
      await page.evaluate(() => { window.__mobileFixture.state.agent.unsupported = true })
      await page.click('#dashboard-nav [data-page="project"]', { label: 'leave chats' })
      await page.click('#dashboard-nav [data-page="chat"]', { label: 'reload chats' })
      await page.waitForFunction(() => /版本较旧/.test(document.querySelector('#chat-error').textContent))
      await page.evaluate(() => { window.__mobileFixture.state.agent.unsupported = false })
    })

    await writeFile(resolve(output, 'results.json'), JSON.stringify({ engine: 'ego-browser', nativeAndroid: false, results }, null, 2))
    console.log({ output, results })
    if (finish) await task.finish({ keep: [] })
  } catch (error) {
    await shot('failure.png').catch(() => {})
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ spaceId: task.spaceId, results, error: String(error?.stack ?? error) }, null, 2))
    console.log({ spaceId: task.spaceId, output, results, error: String(error?.stack ?? error) })
    throw error
  }
}
