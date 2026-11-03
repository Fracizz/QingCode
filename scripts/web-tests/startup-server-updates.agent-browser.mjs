import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `startup-servers-${process.pid}`
const artifactDir = resolve('.dev/web-tests/startup-server-updates')
mkdirSync(artifactDir, { recursive: true })
const results = []
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const check = (name, condition) => {
  run('wait', '--fn', condition)
  results.push({ name, passed: true })
}
const capture = name => run('screenshot', resolve(artifactDir, `${name}.png`))
const count = (kind, value) => `document.querySelector('[data-testid="${kind}-calls"]').textContent === '${value}'`
const noDialog = `!document.querySelector('[role="dialog"]')`
const open = query => {
  run('open', `http://127.0.0.1:38439/web-tests/server-version-update.html?startup&${query}`)
  run('wait', '--fn', `Boolean(document.querySelector('[data-testid="update-calls"]'))`)
}
const finish = () => run('find', 'role', 'button', 'click', '--name', '完成更新', '--exact')
try {
  run('set', 'viewport', '1200', '900')
  open('')
  check('launch automatically updates from a local package without opening any dialog', `${count('update', 1)} && ${count('prepare', 1)} && ${count('download', 0)} && ${noDialog}`)
  check('launch progress uses the real nonmodal progress card', `document.querySelector('.server-operation-card')?.textContent.includes('正在通过 SSH 上传并校验服务包') && ${noDialog}`)
  capture('startup-updating')
  finish()
  check('completion emits a visible notification and never opens a modal', `document.querySelector('.toast-item')?.textContent.includes('已自动更新 WinDev 的远端服务') && ${noDialog} && ${count('update', 1)}`)
  capture('startup-complete')
  open('package=old')
  check('an incompatible offline package keeps manual recovery and never updates', `document.querySelector('.server-operation-card [role="alert"]')?.textContent.includes('版本不匹配') && ${count('update', 0)} && ${count('download', 0)} && ${noDialog}`)
  capture('startup-invalid-package')
  open('package=download')
  check('launch does not download even when automatic download is enabled', `document.querySelector('.server-operation-card [role="alert"]')?.textContent.includes('本机离线包') && ${count('update', 0)} && ${count('download', 0)} && ${noDialog}`)
  open('ready')
  check('an already current service is never reinstalled', `${count('update', 0)} && ${count('prepare', 0)} && ${noDialog}`)
  open('untrusted')
  check('untrusted projects do not authorize startup preparation', `${count('update', 0)} && ${count('prepare', 0)} && ${noDialog}`)
  open('fail')
  check('startup submits once before the simulated update failure', count('update', 1))
  finish()
  check('failed startup update stays nonmodal and does not report success', `document.querySelector('.server-operation-card [role="alert"]')?.textContent.includes('update refused') && !document.querySelector('.toast-item') && ${count('update', 1)} && ${noDialog}`)
  capture('startup-update-failed')
  console.log(`Passed ${results.length} startup browser checks. Artifacts: ${artifactDir}`)
} catch (error) {
  results.push({ name: String(error), passed: false })
  capture('failure')
  writeFileSync(resolve(artifactDir, 'failure.txt'), run('snapshot', '-i'))
  process.exitCode = 1
} finally {
  writeFileSync(resolve(artifactDir, 'results.json'), JSON.stringify({ nativeIntegration: false, engine: 'agent-browser', results }, null, 2))
  writeFileSync(resolve(artifactDir, 'browser-errors.json'), run('errors', '--json'))
  run('close')
}
