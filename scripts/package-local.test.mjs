import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { buildPlan, executePlan, pruneReleaseVersions, save, versionFromArtifactName } from './package-local.mjs'

test('a transient Windows replacement lock preserves and then updates the JSON status', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qingcode-package-state-'))
  try {
    const file = path.join(directory, 'status.json')
    writeFileSync(file, JSON.stringify({ status: 'running' }))
    let attempts = 0
    save(file, { status: 'succeeded' }, (source, destination) => {
      if (++attempts < 3) {
        assert.equal(JSON.parse(readFileSync(destination, 'utf8')).status, 'running')
        throw Object.assign(new Error('File is temporarily locked'), { code: 'EPERM' })
      }
      renameSync(source, destination)
    }, () => {})
    assert.equal(attempts, 3)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'succeeded')
    assert.throws(() => save(file, {}, () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }) }, () => {}), /Disk full/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('default plan builds the installer, Server and APK without the portable exe', () => {
  const tasks = buildPlan()
  assert.deepEqual(tasks.map(task => task.id), ['frontend', 'icons', 'server', 'embed', 'installer', 'apk'])
  assert.deepEqual(tasks.find(task => task.id === 'embed').needs, ['frontend', 'icons', 'server'])
  assert.deepEqual(tasks.find(task => task.id === 'installer').needs, ['embed'])
  assert.deepEqual(tasks.find(task => task.id === 'apk').needs, ['icons'])
  const installerArgs = tasks.find(task => task.id === 'installer').args
  assert.ok(installerArgs.includes('-SkipServerPack'))
  assert.ok(installerArgs.includes('-SkipLatestAlias'))
  assert.ok(!tasks.some(task => task.id === 'exe'))
  assert.deepEqual(buildPlan(), buildPlan({ only: 'local' }))
  assert.deepEqual(buildPlan({ only: 'installer' }).map(task => task.id), ['frontend', 'icons', 'server', 'embed', 'installer'])
})

test('desktop stages share preparation and serialize the Cargo output; APK stays independent', () => {
  const tasks = buildPlan({ only: 'all' })
  assert.deepEqual(tasks.find(task => task.id === 'embed').needs, ['frontend', 'icons', 'server'])
  assert.deepEqual(tasks.find(task => task.id === 'exe').needs, ['embed'])
  assert.deepEqual(tasks.find(task => task.id === 'installer').needs, ['exe'])
  assert.ok(!tasks.find(task => task.id === 'installer').args.includes('-SkipLatestAlias'))
  assert.deepEqual(tasks.find(task => task.id === 'apk').needs, ['icons'])
  assert.deepEqual(buildPlan({ only: 'apk', skipIcons: true }).map(task => task.id), ['server', 'apk'])
  assert.ok(!buildPlan({ only: 'desktop' }).some(task => task.id === 'apk'))
  assert.throws(() => buildPlan({ only: 'unknown' }))
})

test('versioned local artifacts are recognized without treating aliases as versions', () => {
  assert.equal(versionFromArtifactName('QingCode_0.1.15-beta.8-setup.exe'), '0.1.15-beta.8')
  assert.equal(versionFromArtifactName('QingCode_0.1.15-beta.8.exe'), '0.1.15-beta.8')
  assert.equal(versionFromArtifactName('QingCode_0.1.15-beta.8-android.apk'), '0.1.15-beta.8')
  assert.equal(versionFromArtifactName('QingCode_1.2.3-windows-x64-setup.exe'), '1.2.3')
  assert.equal(versionFromArtifactName('QingCode-setup.exe'), null)
  assert.equal(versionFromArtifactName('QingCode-Android.apk'), null)
  assert.equal(versionFromArtifactName('notes.txt'), null)
})

test('release retention keeps the newest three versions and leaves aliases alone', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qingcode-package-retention-'))
  const files = [
    'QingCode_0.1.15-beta.6-setup.exe',
    'QingCode_0.1.15-beta.7-android.apk',
    'QingCode_0.1.15-beta.8.exe',
    'QingCode_0.1.15-beta.9-setup.exe',
    'QingCode_0.1.15-beta.10-setup.exe',
    'QingCode-setup.exe',
    'QingCode-Android.apk',
    'notes.txt',
  ]
  try {
    for (const name of files) writeFileSync(path.join(directory, name), name)
    const result = pruneReleaseVersions({ releaseDir: directory, keep: 3 })
    assert.deepEqual(result.keptVersions, ['0.1.15-beta.10', '0.1.15-beta.9', '0.1.15-beta.8'])
    assert.deepEqual(result.removed.sort(), ['QingCode_0.1.15-beta.6-setup.exe', 'QingCode_0.1.15-beta.7-android.apk'])
    assert.ok(existsSync(path.join(directory, 'QingCode-setup.exe')))
    assert.ok(existsSync(path.join(directory, 'QingCode-Android.apk')))
    assert.ok(existsSync(path.join(directory, 'notes.txt')))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

const fixtureTask = (id, needs = [], code = 'setTimeout(() => {}, 250)') => ({ id, needs, command: process.execPath, args: ['-e', code] })

test('independent tasks overlap and dependent stages wait for completion', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qingcode-package-parallel-'))
  const events = []
  try {
    const state = await executePlan({ directory, cwd: directory, jobs: 2,
      tasks: [fixtureTask('a'), fixtureTask('b'), fixtureTask('c', ['a', 'b'])],
      onEvent: event => events.push(event),
    })
    assert.equal(state.status, 'succeeded')
    assert.ok(events.indexOf(events.find(event => event.startsWith('[b] started'))) < events.indexOf(events.find(event => event.startsWith('[a] succeeded'))))
    assert.ok(Date.parse(state.tasks[2].startedAt) >= Date.parse(state.tasks[0].finishedAt))
    assert.ok(Date.parse(state.tasks[2].startedAt) >= Date.parse(state.tasks[1].finishedAt))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('targeted cancellation kills descendants, cancels dependents and lets independent work finish', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qingcode-package-cancel-'))
  const descendant = path.join(directory, 'descendant.pid')
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(descendant)},String(child.pid)); setInterval(()=>{},1000)`
  try {
    const running = executePlan({ directory, cwd: directory, jobs: 2,
      tasks: [fixtureTask('apk', [], code), fixtureTask('copy', ['apk']), fixtureTask('desktop')], onEvent() {},
    })
    let childPid
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try { childPid = Number(readFileSync(descendant, 'utf8')); break } catch { await delay(50) }
    }
    assert.ok(childPid, 'child process should have started')
    writeFileSync(path.join(directory, 'cancel-test.json'), JSON.stringify({ task: 'apk' }))
    const state = await running
    assert.equal(state.status, 'cancelled')
    assert.equal(state.tasks.find(task => task.id === 'apk').status, 'cancelled')
    assert.equal(state.tasks.find(task => task.id === 'copy').status, 'cancelled')
    assert.equal(state.tasks.find(task => task.id === 'desktop').status, 'succeeded')
    assert.throws(() => process.kill(childPid, 0), 'descendant must not survive cancellation')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a failed stage stops other running work and never starts dependents', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qingcode-package-failure-'))
  try {
    const state = await executePlan({ directory, cwd: directory, jobs: 2,
      tasks: [fixtureTask('fail', [], 'process.exit(7)'), fixtureTask('busy', [], 'setInterval(()=>{},1000)'), fixtureTask('dependent', ['fail'])], onEvent() {},
    })
    assert.equal(state.status, 'failed')
    assert.equal(state.tasks[0].exitCode, 7)
    assert.equal(state.tasks[1].status, 'cancelled')
    assert.equal(state.tasks[2].status, 'cancelled')
    assert.equal(state.tasks[2].pid, undefined)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
