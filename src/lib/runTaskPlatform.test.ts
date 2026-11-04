import { describe, expect, it } from 'vitest'
import { parseRunTaskOs, resolveRunTask } from './runTaskPlatform'
import type { RunTask } from '../store/runConfigStore'

const task: RunTask = {
  id: 'backend',
  type: 'command',
  target: '.venv/bin/python manage.py runserver',
  cwd: 'backend',
  env: { COMMON: 'yes', MODE: 'base' },
  os: {
    windows: { target: '.venv\\Scripts\\python.exe manage.py runserver', env: { MODE: 'win' } },
    linux: { cwd: '', env: { LINUX: 'yes' } },
    macos: { type: 'sh', target: 'dev.sh' },
  },
}

describe('run task OS overrides', () => {
  it('merges only the selected OS without mutating shared defaults', () => {
    const original = JSON.stringify(task)
    expect(resolveRunTask(task, 'windows')).toMatchObject({
      cwd: 'backend',
      target: '.venv\\Scripts\\python.exe manage.py runserver',
      env: { COMMON: 'yes', MODE: 'win' },
    })
    expect(resolveRunTask(task, 'linux')).toMatchObject({
      cwd: '',
      target: task.target,
      env: { COMMON: 'yes', MODE: 'base', LINUX: 'yes' },
    })
    expect(resolveRunTask(task, 'macos')).toMatchObject({ type: 'sh', target: 'dev.sh' })
    expect(JSON.stringify(task)).toBe(original)
  })

  it('keeps legacy commands and falls back when an OS override is absent', () => {
    const legacy: RunTask = { id: 'frontend', type: 'command', target: 'pnpm dev' }
    for (const os of ['windows', 'linux', 'macos'] as const) {
      expect(resolveRunTask(legacy, os)).toEqual(legacy)
    }
    expect(
      resolveRunTask({ ...legacy, os: { windows: { target: 'npm run dev' } } }, 'linux').target
    ).toBe('pnpm dev')
  })

  it('allows OS-only targets and reports a missing applicable command', () => {
    const only: RunTask = {
      id: 'worker',
      type: 'command',
      target: '',
      os: { linux: { target: 'celery -A app worker' } },
    }
    expect(resolveRunTask(only, 'linux').target).toContain('celery')
    expect(() => resolveRunTask(only, 'windows')).toThrow('windows')
  })

  it.each([
    { win32: { target: 'wrong key' } },
    { linux: { env: { PORT: 3000 } } },
    { linux: { type: 'typo' } },
    { linux: { command: 'wrong field' } },
    { linux: [] },
    null,
  ])('rejects invalid overrides instead of dropping them: %j', value => {
    expect(() => parseRunTaskOs(value)).toThrow()
  })
})
