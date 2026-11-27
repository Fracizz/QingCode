import { describe, expect, it } from 'vitest'
import { intFlag, parseQnArgs, plainTail, QnUsageError, runQn } from './cli'

describe('parseQnArgs', () => {
  it('解析命令、子命令、位置参数与开关', () => {
    expect(parseQnArgs(['run', 'output', 'r1', '--tail=50', '--json'])).toEqual({
      command: 'run', sub: 'output', positionals: ['r1'], flags: { tail: '50', json: true },
    })
    expect(parseQnArgs(['notify', '构建', '完成', '--title', 'CI'])).toEqual({
      command: 'notify', positionals: ['构建', '完成'], flags: { title: 'CI' },
    })
    expect(parseQnArgs(['open', '--', '--weird-name.ts'])).toMatchObject({ positionals: ['--weird-name.ts'] })
    expect(parseQnArgs([])).toMatchObject({ command: 'help' })
  })

  it('拒绝未知命令、未知参数与缺失的子命令', () => {
    expect(() => parseQnArgs(['exec', 'rm'])).toThrow(QnUsageError)
    expect(() => parseQnArgs(['session', 'list'])).toThrow(QnUsageError)
    expect(() => parseQnArgs(['notify', '--force'])).toThrow('未知参数 --force')
    expect(() => parseQnArgs(['run', 'start'])).toThrow('list | output')
    expect(() => parseQnArgs(['notify', '--title'])).toThrow('需要取值')
    expect(() => parseQnArgs(['status', '--json=1'])).toThrow('不接受取值')
  })

  it('整数参数校验', () => {
    expect(intFlag({ line: '12' }, 'line', 1)).toBe(12)
    expect(intFlag({}, 'line', 1)).toBeUndefined()
    expect(() => intFlag({ line: '0' }, 'line', 1)).toThrow(QnUsageError)
    expect(() => intFlag({ line: 'x' }, 'line')).toThrow(QnUsageError)
  })
})

describe('输出整理', () => {
  it('plainTail 去 ANSI、处理回车覆盖并取末尾行', () => {
    const raw = '\x1b[32mok\x1b[0m\r\nprogress 10%\rprogress 100%\r\n\x1b]0;title\x07last\r\n\r\n'
    expect(plainTail(raw, 10)).toBe('ok\nprogress 100%\nlast')
    expect(plainTail('a\nb\nc', 2)).toBe('b\nc')
  })

})

describe('runQn', () => {
  const io = (env: NodeJS.ProcessEnv) => {
    const out: string[] = []
    const err: string[] = []
    return {
      out, err,
      io: { env, cwd: '/w', stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
    }
  }

  it('guide 不需要连接 daemon', async () => {
    const t = io({})
    expect(await runQn(['guide'], t.io)).toBe(0)
    expect(t.out.join('')).toContain('qn notify')
  })

  it('不在 QingCode 环境中时给出明确提示', async () => {
    const t = io({})
    expect(await runQn(['status'], t.io)).toBe(2)
    expect(t.err.join('')).toContain('QN_AGENT_TOKEN')
  })
})
