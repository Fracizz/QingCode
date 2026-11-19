// README 手机版截图：复用 /mobile-android/ 真实页面与内存桥，按中英文各拍连接、项目、终端、会话侧栏四张高清图。
// 先启动 `pnpm test:web`，再运行：
//   node scripts/web-tests/headless-task-space.mjs <仓库绝对路径>/scripts/web-tests/readme-mobile-screenshots.ego.mjs
// 输出到 docs/screenshots/{zh,en}-mobile-0N-*.png（412×915 视口，3 倍像素比）。
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VIEWPORT = { width: 412, height: 915, deviceScaleFactor: 3, mobile: true }

export async function run({ spaceId, baseUrl = 'http://127.0.0.1:38439', artifactDir, langs = ['zh', 'en'] } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const output = artifactDir ?? resolve(repo, 'docs/screenshots')
  await mkdir(output, { recursive: true })
  // 终端里展示仓库真实的 git 输出，而不是虚构程序画面。
  const git = args => execFileSync('git', ['-C', repo, '-c', 'color.ui=always', ...args], { encoding: 'utf8' })
  const terminalText = '\x1b[2J\x1b[H' + ['PS D:\\code\\qingcode> git status -sb', git(['status', '-sb', '--untracked-files=no']),
    'PS D:\\code\\qingcode> git log --oneline -14', git(['log', '-14', '--pretty=format:%C(yellow)%h%Creset %<(34,trunc)%s']),
    'PS D:\\code\\qingcode> '].join('\r\n').replace(/\r?\n/g, '\r\n')
  const task = await taskSpace(spaceId ?? 'QingCode README mobile screenshots')
  const page = task.page('p1')
  const settle = () => page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'), undefined, { timeout: 8000 }).catch(() => {})
  const shot = async name => {
    await settle()
    await page.waitForTimeout(250)
    await page.screenshot({ path: resolve(output, name) })
  }
  try {
    for (const lang of langs) {
      const zh = lang === 'zh'
      await page.cdp('Emulation.setDeviceMetricsOverride', VIEWPORT)
      await page.goto(baseUrl + '/mobile-android/')
      await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('qingcode:mobile:')) localStorage.removeItem(key) })
      await page.goto(`${baseUrl}/mobile-android/?lang=${lang}`)
      await page.cdp('Emulation.setDeviceMetricsOverride', VIEWPORT)
      await page.waitForFunction(() => !!document.querySelector('#home-empty-title')?.textContent)
      await page.evaluate(name => window.qingLink(window.__mobileFixture.link('192.168.1.8', 48764, undefined, name)), zh ? '工作电脑' : 'Workstation')
      await page.fill('#pair-code', 'A8z2D3')
      await page.click('#pair-submit')
      await page.waitForFunction(() => document.querySelector('#active-host')?.dataset.state === 'online')
      // 多个项目与会话，让首页「全部会话」和侧栏有内容。
      await page.evaluate(zh => {
        const fixture = window.__mobileFixture
        fixture.state.projects.push(
          { id: 'p-web', name: 'web-console', path: 'D:\\code\\web-console', kind: 'local', host: 'Windows' },
          { id: 'p-wsl', name: 'data-pipeline', path: '/home/dev/data-pipeline', kind: 'wsl', host: 'Ubuntu' },
        )
        fixture.addSession({ project: 'p-local', title: 'PowerShell' })
        fixture.addSession({ project: 'p-local', title: 'Codex' })
        fixture.addSession({ project: 'p-local', title: zh ? '构建与测试' : 'Build & test', exit: { code: 0 } })
        fixture.addSession({ project: 'p-ssh', title: 'OpenCode' })
        fixture.addSession({ project: 'p-ssh', title: zh ? '部署日志' : 'Deploy logs', deviceName: 'Galaxy Tab', ownDevice: false })
        fixture.addSession({ project: 'p-web', title: 'Claude', exit: { code: 0 } })
      }, zh)
      // 切到其他页再回首页，触发重新读取会话。
      await page.click('#dashboard-nav [data-page="connection"]')
      await page.click('#dashboard-nav [data-page="home"]')
      await page.waitForFunction(() => document.querySelectorAll('#home-session-overview .session-option, #home-session-overview [data-session]').length > 0, undefined, { timeout: 8000 }).catch(() => {})
      await shot(`${lang}-mobile-01-home.png`)

      await page.click('#dashboard-nav [data-page="project"]')
      await page.waitForFunction(() => document.querySelectorAll('#project-list .project-row').length >= 2)
      await shot(`${lang}-mobile-02-projects.png`)

      await page.click('#project-list > :first-child .project-row:first-child .row')
      await page.evaluate(() => window.__mobileFixture.startTerminalIfEmpty())
      await page.waitForFunction(() => !!document.querySelector('#terminal-status')?.textContent && document.querySelector('#terminal-empty')?.hidden !== false)
      await page.evaluate(text => {
        const fixture = window.__mobileFixture
        for (const session of fixture.state.sessions.values()) {
        if (session.project !== 'p-local') continue
        // 去掉夹具默认的「PS> 」提示符，只留真实 git 输出。
        session.output.length = 0
        const bytes = new TextEncoder().encode(text)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        session.output.push(btoa(binary))
        session.next += 1
        for (const wake of session.waiters.splice(0)) wake()
        }
      }, terminalText)
      await page.waitForFunction(() => window.__mobileFixture.terminalText().includes('git log'), undefined, { timeout: 8000 })
      if (await page.evaluate(() => !!document.querySelector('#input-tip-dismiss')?.getClientRects().length)) await page.click('#input-tip-dismiss')
      await shot(`${lang}-mobile-03-terminal.png`)

      await page.click('#show-sessions')
      await page.waitForSelector('#session-drawer[open]')
      await shot(`${lang}-mobile-04-sessions.png`)
      await page.click('#session-drawer [data-close]').catch(() => {})
    }
  } finally {
    await task.finish?.()
  }
  return { output }
}
