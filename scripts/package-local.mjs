#!/usr/bin/env node
// Local-only packaging DAG. No Git mutation, tags, uploads or release actions.
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runsRoot = path.join(root, '.dev/package-runs')
const help = `Local packaging (never publishes):
  pnpm package:local [run|start] [--only all|desktop|exe|installer|server|apk]
                     [--jobs 3] [--skip-frontend] [--skip-icons] [--skip-server] [--plan]
  pnpm package:local status <run-id>
  pnpm package:local cancel <run-id> [--task apk]
run is foreground (Ctrl+C cancels its process trees); start runs in the background.
Logs and JSON status: .dev/package-runs/<run-id>/
Only independent stages run in parallel; exe and installer share a Cargo target and run sequentially.`

function json(file) { return JSON.parse(readFileSync(file, 'utf8')) }
function save(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, file)
}
function runPath(id) {
  if (!/^[0-9a-z-]+$/.test(id ?? '')) throw new Error('A valid run ID is required.')
  return path.join(runsRoot, id)
}

export function buildPlan(options = {}) {
  const only = options.only ?? 'all'
  if (!['all', 'desktop', 'exe', 'installer', 'server', 'apk'].includes(only)) throw new Error('Invalid --only component.')
  const desktop = ['all', 'desktop', 'exe', 'installer'].includes(only)
  const apk = ['all', 'apk'].includes(only)
  const tasks = []
  const add = (id, script, args = [], needs = []) => tasks.push({ id, command: 'pwsh', args: ['-NoProfile', '-File', `scripts/${script}`, ...args], needs })
  if (desktop && !options.skipFrontend) add('frontend', 'package-stage.ps1', ['-Stage', 'frontend'])
  if ((desktop || apk) && !options.skipIcons) add('icons', 'package-stage.ps1', ['-Stage', 'icons'])
  if (desktop || only === 'server') add('server', 'package-stage.ps1', ['-Stage', 'server', ...(options.skipServer ? ['-SkipServer'] : [])])
  const desktopNeeds = tasks.filter(task => ['frontend', 'icons', 'server'].includes(task.id)).map(task => task.id)
  if (desktop) add('embed', 'package-stage.ps1', ['-Stage', 'embed'], desktopNeeds)
  const flags = ['-SkipFrontend', '-SkipIcons', '-SkipServer', '-SkipAndroid', '-SkipServerPack']
  if (desktop && only !== 'installer') add('exe', 'package-exe.ps1', flags, ['embed'])
  if (desktop && only !== 'exe') add('installer', 'package-installer.ps1', flags, tasks.some(task => task.id === 'exe') ? ['exe'] : ['embed'])
  if (apk) add('apk', 'package-android-if-needed.ps1', [], tasks.some(task => task.id === 'icons') ? ['icons'] : [])
  return tasks
}

function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
    else process.kill(-child.pid, 'SIGKILL')
  } catch { /* It may have exited between inspection and termination. */ }
}

export async function executePlan({ tasks, cwd, directory, jobs = 3, onEvent = console.log }) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('--jobs must be an integer from 1 to 8.')
  mkdirSync(directory, { recursive: true })
  const stateFile = path.join(directory, 'status.json')
  const state = { id: path.basename(directory), pid: process.pid, status: 'running', startedAt: new Date().toISOString(), tasks: tasks.map(task => ({ id: task.id, needs: task.needs, status: 'queued', log: `${task.id}.log` })) }
  const active = new Map()
  let interrupted = false
  let failed = false
  const interrupt = () => { interrupted = true }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const persist = () => save(stateFile, state)
  persist()
  try {
    while (state.tasks.some(task => ['queued', 'running'].includes(task.status))) {
      const requests = readdirSync(directory).filter(name => /^cancel-.*\.json$/.test(name)).map(name => json(path.join(directory, name)))
      const cancelAll = interrupted || failed || requests.some(request => request.all)
      for (const task of state.tasks) {
        if (!['queued', 'running'].includes(task.status)) continue
        const blocked = task.needs.some(id => ['failed', 'cancelled'].includes(state.tasks.find(item => item.id === id)?.status))
        if (cancelAll || requests.some(request => request.task === task.id) || blocked) {
          task.status = 'cancelled'
          task.finishedAt = new Date().toISOString()
          if (active.has(task.id)) stopTree(active.get(task.id).child)
          onEvent(`[${task.id}] cancelled`)
        }
      }
      for (const task of state.tasks) {
        if (active.size >= jobs) break
        if (task.status !== 'queued' || !task.needs.every(id => state.tasks.find(item => item.id === id)?.status === 'succeeded')) continue
        const spec = tasks.find(item => item.id === task.id)
        const log = openSync(path.join(directory, task.log), 'a')
        let child
        try {
          // Windows PowerShell can silently exit under DETACHED_PROCESS without executing -File.
          // taskkill /T handles Windows descendants; POSIX needs a separate process group.
          child = spawn(spec.command, spec.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', log, log] })
        } finally { closeSync(log) }
        task.status = 'running'
        task.pid = child.pid
        task.startedAt = new Date().toISOString()
        const finished = new Promise(resolve => {
          let error
          child.on('error', err => { error = err.message })
          child.on('close', (code, signal) => {
            active.delete(task.id)
            if (task.status !== 'cancelled') {
              task.status = code === 0 && !error ? 'succeeded' : 'failed'
              task.exitCode = code
              if (error) task.error = error
              if (signal) task.signal = signal
              failed ||= task.status === 'failed'
            }
            task.finishedAt = new Date().toISOString()
            onEvent(`[${task.id}] ${task.status}; log: ${path.join(directory, task.log)}`)
            persist()
            resolve()
          })
        })
        active.set(task.id, { child, finished })
        onEvent(`[${task.id}] started (PID ${child.pid ?? 'unavailable'})`)
      }
      persist()
      if (active.size === 0 && state.tasks.some(task => task.status === 'queued')) throw new Error('Packaging dependency graph cannot make progress.')
      await delay(100)
    }
    await Promise.all([...active.values()].map(item => item.finished))
    state.status = failed ? 'failed' : state.tasks.some(task => task.status === 'cancelled') ? 'cancelled' : 'succeeded'
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    for (const { child } of active.values()) stopTree(child)
    await Promise.all([...active.values()].map(item => item.finished))
    if (state.status === 'running') state.status = 'failed'
    state.finishedAt = new Date().toISOString()
    persist()
  }
  return state
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return }
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'run'
  const options = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--only', '--jobs', '--task', '--run-id'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[arg.slice(2)] = args[++i]
    } else if (['--plan', '--skip-frontend', '--skip-icons', '--skip-server'].includes(arg)) options[arg.slice(2)] = true
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else positional.push(arg)
  }
  if (command === 'status') { console.log(JSON.stringify(json(path.join(runPath(positional[0]), 'status.json')), null, 2)); return }
  if (command === 'cancel') {
    const directory = runPath(positional[0])
    const state = json(path.join(directory, 'status.json'))
    if (['succeeded', 'failed', 'cancelled'].includes(state.status)) { console.log(`Run already ${state.status}.`); return }
    if (options.task && !state.tasks.some(task => task.id === options.task)) throw new Error('Unknown task ID for this run.')
    // Each request has its own file so concurrent cancellation requests cannot overwrite each other.
    save(path.join(directory, `cancel-${randomUUID()}.json`), options.task ? { task: options.task } : { all: true })
    console.log(`Cancellation requested: ${positional[0]}${options.task ? ` / ${options.task}` : ' / all tasks'}`)
    return
  }
  if (!['run', 'start'].includes(command)) throw new Error(`Unknown command: ${command}`)
  const jobs = Number(options.jobs ?? 3)
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('--jobs must be an integer from 1 to 8.')
  const tasks = buildPlan({ only: options.only, skipFrontend: options['skip-frontend'], skipIcons: options['skip-icons'], skipServer: options['skip-server'] })
  if (options.plan) { console.log(JSON.stringify({ jobs, tasks }, null, 2)); return }
  const id = options['run-id'] ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const directory = runPath(id)
  mkdirSync(directory, { recursive: true })
  if (command === 'start') {
    const log = openSync(path.join(directory, 'runner.log'), 'a')
    save(path.join(directory, 'status.json'), { id, status: 'queued', tasks: tasks.map(task => ({ id: task.id, status: 'queued' })) })
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', ...args, '--run-id', id], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] })
    closeSync(log)
    child.on('error', error => { save(path.join(directory, 'status.json'), { id, status: 'failed', error: error.message }); process.exitCode = 1 })
    child.unref()
    console.log(`Started ${id}\nLog: ${path.join(directory, 'runner.log')}\nCancel: pnpm package:local cancel ${id}`)
    return
  }
  // A checkout owns one packaging run at a time: dist/, Cargo output and release/ are shared.
  const lock = path.join(runsRoot, 'active.lock')
  let descriptor
  try { descriptor = openSync(lock, 'wx') } catch {
    save(path.join(directory, 'status.json'), { id, status: 'failed', error: `Another packaging run owns ${lock}.` })
    throw new Error(`Another packaging run owns ${lock}. Inspect its status before retrying.`)
  }
  writeFileSync(descriptor, JSON.stringify({ id, pid: process.pid }))
  closeSync(descriptor)
  console.log(`Run ${id}; concurrency ${jobs}\nCancel: pnpm package:local cancel ${id}`)
  try {
    const state = await executePlan({ tasks, cwd: root, directory, jobs })
    console.log(`Packaging ${state.status}. Status: ${path.join(directory, 'status.json')}`)
    process.exitCode = state.status === 'succeeded' ? 0 : state.status === 'cancelled' ? 130 : 1
  } finally { rmSync(lock, { force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
