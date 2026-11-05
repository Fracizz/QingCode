// 无交互桌面的 Windows 主机（例如经 SSH 登录的会话）上，Ego 窗口不渲染，截图会超时。
// 本适配层用无头 Chrome + CDP 提供 ego 验收脚本用到的 taskSpace / page API 子集，便于同一脚本照常断言和截图。
// 用法：node scripts/web-tests/headless-task-space.mjs <脚本绝对路径> [run 参数 JSON]
// 可用 CHROME_PATH 指定浏览器；有桌面时仍优先用 ego-browser（见 docs/web-ui-testing.md）。
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), 'qc-headless-'))
  const port = 9400 + Math.floor(Math.random() * 400)
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
  let version
  for (let attempt = 0; attempt < 100 && !version; attempt++) {
    await sleep(150)
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { /* 等待启动 */ }
  }
  if (!version) throw new Error('无头 Chrome 未能启动')
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject) })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    } else for (const listener of listeners) listener(message)
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await Promise.race([send('Browser.close'), sleep(1500)]) } catch { /* 已关闭 */ }
    chrome.kill()
    await sleep(300)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  return { send, listeners, close }
}

function createPage(browser) {
  let sessionId
  const page = { targetId: null }
  const ready = (async () => {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    page.targetId = targetId
    sessionId = (await browser.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
    await browser.send('Page.enable', {}, sessionId)
    await browser.send('Runtime.enable', {}, sessionId)
  })()
  const cdp = async (method, params = {}) => { await ready; return browser.send(method, params, sessionId) }
  const loaded = () => new Promise(resolve => {
    const listener = message => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') { browser.listeners.delete(listener); resolve() }
    }
    browser.listeners.add(listener)
  })
  async function evaluate(fn, arg) {
    const expression = typeof fn === 'function' ? `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})` : String(fn)
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  async function waitFor(check, timeout = 30000, label = 'condition') {
    const until = Date.now() + timeout
    let lastError
    while (Date.now() < until) {
      try { if (await check()) return true } catch (error) { lastError = error }
      await sleep(80)
    }
    throw new Error(`等待超时：${label}${lastError ? '（' + lastError.message + '）' : ''}`)
  }
  // 解析普通 CSS 选择器或 loc=role:button[name="…"] / name*="…" 定位器，返回可点击元素的中心点。
  const locate = selector => evaluate(source => {
    let element
    const role = /^loc=role:button\[name(\*?)="(.+)"\]$/.exec(source)
    if (role) {
      const name = item => (item.getAttribute('aria-label') ?? item.innerText ?? '').replace(/\s+/g, ' ').trim()
      const candidates = [...document.querySelectorAll('button, [role="button"]')].filter(item => item.getClientRects().length)
      element = candidates.find(item => role[1] ? name(item).includes(role[2]) : name(item) === role[2])
    } else element = document.querySelector(source)
    if (!element || !element.getClientRects().length || element.disabled) return null
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const box = element.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, selector)
  Object.assign(page, {
    cdp,
    evaluate,
    async goto(url, { timeout = 30000 } = {}) {
      const done = loaded()
      await cdp('Page.navigate', { url })
      await Promise.race([done, sleep(timeout)])
    },
    async reload() {
      const done = loaded()
      await cdp('Page.reload', {})
      await Promise.race([done, sleep(30000)])
    },
    async waitForFunction(fn, arg, options) {
      const timeout = (options ?? (arg && typeof arg === 'object' && 'timeout' in arg ? arg : {})).timeout ?? 30000
      return waitFor(() => evaluate(fn, arg), timeout, String(fn).slice(0, 120))
    },
    async waitForSelector(selector, { timeout = 30000 } = {}) {
      return waitFor(() => evaluate(source => !!document.querySelector(source)?.getClientRects().length, selector), timeout, selector)
    },
    async waitForTimeout(ms) { await sleep(ms) },
    async click(selector) {
      // 等元素位置稳定（弹层滑入动画结束）再点击，避免点到遮罩。
      let point
      let previous
      await waitFor(async () => {
        point = await locate(selector)
        const stable = point && previous && Math.abs(point.x - previous.x) < 0.5 && Math.abs(point.y - previous.y) < 0.5
        previous = point
        return stable
      }, 15000, 'click ' + selector)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
      }
      await sleep(30)
    },
    async fill(selector, value) {
      await waitFor(() => locate(selector), 15000, 'fill ' + selector)
      await evaluate(source => {
        const element = document.querySelector(source)
        element.focus()
        element.select?.()
      }, selector)
      if (value) await cdp('Input.insertText', { text: String(value) })
      else await evaluate(source => {
        const element = document.querySelector(source)
        element.value = ''
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }, selector)
      await evaluate(source => document.querySelector(source).dispatchEvent(new Event('change', { bubbles: true })), selector)
    },
    async selectOption(selector, choice) {
      await evaluate(([source, option]) => {
        const element = document.querySelector(source)
        const match = [...element.options].find(item => typeof option === 'string' ? item.value === option : item.label === option.label || item.value === option.value)
        element.value = match.value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }, [selector, choice])
    },
    async screenshot({ path } = {}) {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
      if (path) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, Buffer.from(data, 'base64'))
      }
      return Buffer.from(data, 'base64')
    },
    mouse: {
      position: { x: 0, y: 0 },
      async move(x, y) {
        page.mouse.position = { x, y }
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      },
      async wheel(deltaX, deltaY) {
        const { x, y } = page.mouse.position
        await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
        await sleep(100)
      },
    },
    async snapshot() { return evaluate(() => document.body.innerText.slice(0, 4000)) },
  })
  return page
}

let spaces = 0
const browsers = []
globalThis.taskSpace = async () => {
  const browser = await launch()
  browsers.push(browser)
  const pages = new Map()
  return {
    spaceId: ++spaces,
    page(name) {
      if (!pages.has(name)) pages.set(name, createPage(browser))
      return pages.get(name)
    },
    cdp: (method, params) => browser.send(method, params),
    finish: () => browser.close(),
  }
}

const [script, rawArgs] = process.argv.slice(2)
if (script) {
  const module = await import(pathToFileURL(script).href)
  let code = 0
  try {
    await module.run(rawArgs ? JSON.parse(rawArgs) : undefined)
  } catch (error) {
    console.error(error)
    code = 1
  } finally {
    // 失败时脚本不会调用 finish，这里统一关闭浏览器。
    for (const browser of browsers) await browser.close()
  }
  process.exit(code)
}
