import { describe, expect, it } from 'vitest'
import {
  encodeCwdDir,
  listPiSessions,
  parseSessionLines,
  sameCwd,
  type SessionIo,
} from './sessions'

const header = (cwd: string) =>
  JSON.stringify({ type: 'session', version: 3, id: 's-1', timestamp: '2026-11-25T10:00:00.000Z', cwd })

describe('会话目录名与 cwd 过滤', () => {
  it('Windows / POSIX 路径都按官方格式编码', () => {
    expect(encodeCwdDir('D:\\code\\qingcode-next')).toBe('--D--code-qingcode-next--')
    expect(encodeCwdDir('/home/user/proj')).toBe('--home-user-proj--')
  })

  it('sameCwd 忽略大小写与分隔符差异（Windows）', () => {
    expect(sameCwd('D:\\code\\proj', 'd:/code/proj')).toBe(
      process.platform === 'win32' ? true : false,
    )
    expect(sameCwd('/work', '/work/')).toBe(true)
  })
})

describe('session-format 头部解析', () => {
  it('只读头部、首条用户消息与会话名', () => {
    const lines = [
      header('D:\\code\\proj'),
      JSON.stringify({ type: 'message', message: { role: 'system', content: '' } }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: '请重构登录模块' }] },
      }),
      JSON.stringify({ type: 'session_info', name: '登录重构' }),
    ]
    expect(parseSessionLines(lines)).toMatchObject({
      id: 's-1',
      cwd: 'D:\\code\\proj',
      preview: '请重构登录模块',
      name: '登录重构',
      createdAt: Math.floor(Date.parse('2026-11-25T10:00:00.000Z') / 1000),
    })
  })

  it('截断的最后一行不是完整 JSON 时忽略，不影响头部', () => {
    const parsed = parseSessionLines([header('/work'), '{"type":"message",'])
    expect(parsed?.id).toBe('s-1')
    expect(parsed?.preview).toBeUndefined()
  })

  it('没有 session 头或非 .jsonl 文件都不算会话', () => {
    expect(parseSessionLines(['{"type":"message"}'])).toBeNull()
    expect(parseSessionLines([JSON.stringify({ type: 'session', id: '', cwd: '/w' })])).toBeNull()
  })
})

describe('listPiSessions（只读会话文件）', () => {
  const cwd = process.platform === 'win32' ? 'D:\\code\\proj' : '/work/proj'
  const sub = encodeCwdDir(cwd)

  it('同时支持默认分组目录与平铺的自定义 session-dir，并按 header.cwd 过滤', () => {
    const files: Record<string, string> = {
      [`ROOT/${sub}/a.jsonl`]: `${header(cwd)}\n`,
      'ROOT/flat-b.jsonl': `${header(cwd)}\n`,
      'ROOT/other-c.jsonl': `${header('/somewhere/else')}\n`,
      'ROOT/not-session.jsonl': '{"type":"message"}\n',
      'ROOT/auth.json': '{"token":"must-not-be-read"}\n',
    }
    const io: SessionIo = {
      // Windows 下 path.join 用反斜杠，假 IO 统一按正斜杠查表。
      readDir: (rawDir) => {
        const dir = rawDir.replace(/\\/g, '/')
        return [...new Set(Object.keys(files)
          .filter((file) => file.startsWith(`${dir}/`))
          .map((file) => file.slice(dir.length + 1).split('/')[0]!))]
      },
      stat: () => ({ mtimeMs: 1_700_000_000_000 }),
      readHead: (file) => files[file.replace(/\\/g, '/')] ?? '',
    }
    const result = listPiSessions(cwd, io, 'ROOT')
    expect(result.map((info) => info.meta.id)).toEqual(['s-1', 's-1'])
    expect(result).toHaveLength(2)
    expect(result[0]?.sessionFile).toContain('.jsonl')
    expect(result[0]?.meta.updatedAt).toBe(1_700_000_000)
    // 认证文件从不在读取列表里。
    expect(Object.keys(files).filter((file) => file.endsWith('auth.json'))).toHaveLength(1)
    expect(result.some((info) => info.sessionFile.endsWith('auth.json'))).toBe(false)
    expect(listPiSessions([cwd, '/somewhere/else'], io, 'ROOT')).toHaveLength(3)
    expect(listPiSessions(undefined, io, 'ROOT')).toHaveLength(3)
  })

  it('会话目录不存在时返回空列表，不抛错', () => {
    const io: SessionIo = {
      readDir: () => {
        throw new Error('ENOENT')
      },
      stat: () => ({ mtimeMs: 0 }),
      readHead: () => '',
    }
    expect(listPiSessions(cwd, io, 'MISSING')).toEqual([])
  })
})
