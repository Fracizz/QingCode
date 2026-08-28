import { describe, expect, it } from 'vitest'
import { parseCliRunConfig, parseOpenTarget } from './cliBridge'

describe('parseOpenTarget', () => {
  it('parses unix path with line and column', () => {
    expect(parseOpenTarget('/tmp/a.ts:10:2')).toEqual({
      path: '/tmp/a.ts',
      line: 10,
      column: 2,
    })
  })

  it('parses windows path with line', () => {
    expect(parseOpenTarget('D:\\Work\\a.ts:12')).toEqual({
      path: 'D:\\Work\\a.ts',
      line: 12,
      column: undefined,
    })
  })

  it('parses windows path with line and column', () => {
    expect(parseOpenTarget('D:\\Work\\a.ts:12:3')).toEqual({
      path: 'D:\\Work\\a.ts',
      line: 12,
      column: 3,
    })
  })

  it('keeps plain path', () => {
    expect(parseOpenTarget('D:\\Work\\a.ts')).toEqual({ path: 'D:\\Work\\a.ts' })
  })
})

describe('parseCliRunConfig', () => {
  it('creates and normalizes a bare run config', () => {
    const result = parseCliRunConfig(
      JSON.stringify({
        name: 'remote dev',
        restoreWithProjectSession: true,
        tasks: [{ type: 'script', target: ' scripts/dev.py ', cwd: ' api ' }],
      }),
      []
    )
    expect(result.action).toBe('created')
    expect(result.config.id).toBeTruthy()
    expect(result.config.tasks[0]).toMatchObject({
      type: 'script',
      target: 'scripts/dev.py',
      cwd: 'api',
    })
  })

  it('updates by name while preserving the existing id', () => {
    const result = parseCliRunConfig(
      JSON.stringify({ config: { name: 'dev', tasks: [{ target: 'pnpm dev' }] } }),
      [{ id: 'existing', name: 'dev', tasks: [] }]
    )
    expect(result.action).toBe('updated')
    expect(result.config.id).toBe('existing')
    expect(result.config.tasks[0].type).toBe('command')
  })

  it('rejects invalid environment values', () => {
    expect(() =>
      parseCliRunConfig(
        JSON.stringify({ name: 'dev', tasks: [{ target: 'pnpm dev', env: { PORT: 3000 } }] }),
        []
      )
    ).toThrow('env must contain string values')
  })
})
