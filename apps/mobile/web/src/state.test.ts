import { describe, expect, it } from 'vitest'
import {
  applyTargetState,
  errorCode,
  formatQuotedMessage,
  formatTime,
  friendlyError,
  HOST_KEY_HINT,
  hostKeyMessage,
  isHostKeyError,
  joinPath,
  parentPath,
  parseConnections,
  parseProjects,
  parseTargets,
  projectsForTarget,
  quoteText,
  serializeConnections,
  targetStatus,
  toThreadSummaries,
} from './state'

const FP = 'cd'.repeat(32)

describe('parseTargets / parseProjects', () => {
  it('归一化目标并保证本机在首位', () => {
    const targets = parseTargets([
      { id: 'ssh-1', kind: 'ssh', name: '93', host: '192.168.10.93', port: 22, username: 'root', auth: { kind: 'privateKey', keyPath: 'C:\\keys\\id' } },
      { id: 'local', kind: 'local', name: '本机' },
      { id: 'bad', kind: 'weird', name: 'x' },
      null,
    ])
    expect(targets.map((item) => item.id)).toEqual(['local', 'ssh-1'])
    expect(targets[1]).toMatchObject({ kind: 'ssh', auth: { kind: 'agent' } })
    expect(parseTargets({ data: [] })).toEqual([])
  })

  it('解析 key 认证与秒/毫秒时间戳', () => {
    const targets = parseTargets([
      { id: 'k', kind: 'ssh', name: 'k', host: 'h', port: 2222, username: 'u', auth: { kind: 'key', keyPath: '/k' } },
    ])
    expect(targets[0]).toMatchObject({ auth: { kind: 'key', keyPath: '/k' } })

    const projects = parseProjects([
      { id: 'p1', targetId: 'local', name: '', path: 'D:\\code\\a', lastOpenedAt: 1_700_000_000 },
      { id: 'p2', targetId: 'local', name: 'b', path: '/root/b', lastOpenedAt: 1_700_000_000_000 },
      { id: 'p3', targetId: 'ssh-1', name: 'c', path: '/c', lastOpenedAt: 0 },
    ])
    expect(projects[0]?.name).toBe('a')
    expect(projects[0]?.lastOpenedAt).toBe(1_700_000_000_000)
    expect(projectsForTarget(projects, 'local').map((item) => item.id)).toEqual(['p1', 'p2'])
  })
})

describe('applyTargetState / targetStatus', () => {
  it('只接受合法状态并保留 detail', () => {
    const empty = {}
    const next = applyTargetState(empty, { id: 'local', state: 'ready' })
    expect(next).toEqual({ local: { id: 'local', state: 'ready' } })
    expect(empty).toEqual({})
    const failed = applyTargetState(next, { id: 'local', state: 'error', detail: 'ssh 失败' })
    expect(failed.local).toEqual({ id: 'local', state: 'error', detail: 'ssh 失败' })
    expect(targetStatus(failed, 'local')).toBe('error')
    expect(targetStatus(failed, 'other')).toBe('idle')
    expect(applyTargetState(next, { id: 'x', state: 'unknown' })).toBe(next)
    expect(applyTargetState(next, null)).toBe(next)
  })
})

describe('parseConnections', () => {
  it('往返序列化并丢弃非法项', () => {
    const raw = serializeConnections([
      { id: 'a', name: '电脑', host: '192.168.1.2', port: 38500, fp: FP, token: 'tok', desktopName: 'PC', createdAt: 1 },
      { id: 'bad', name: '', host: 'bad host', port: 38500, fp: FP, token: 'tok', desktopName: '', createdAt: 0 },
      { id: 'no-token', name: '', host: 'h', port: 38500, fp: FP, token: '', desktopName: '', createdAt: 0 },
    ])
    const parsed = parseConnections(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ id: 'a', host: '192.168.1.2', port: 38500, fp: FP })
    expect(parseConnections('not json')).toEqual([])
    expect(parseConnections(null)).toEqual([])
  })
})

describe('toThreadSummaries / formatTime', () => {
  it('按更新时间倒序，兼容秒级时间戳', () => {
    const summaries = toThreadSummaries({
      data: [
        { id: 'old', preview: '第一行\n第二行', cwd: '/a', updatedAt: 1_600_000_000 },
        { id: 'new', preview: 'new', name: '命名会话', cwd: '/b', updatedAt: 1_700_000_000_000 },
      ],
    })
    expect(summaries.map((item) => item.id)).toEqual(['new', 'old'])
    expect(summaries[1]?.title).toBe('第一行')
    expect(formatTime(0)).toBe('—')
    expect(formatTime(1_700_000_000_000)).not.toBe('—')
  })
})

describe('错误信息', () => {
  it('SSH 主机指纹错误提示到电脑确认，证书指纹不匹配不当作 SSH 指纹', () => {
    expect(hostKeyMessage({ code: 'hostKey', message: '指纹变化' }, '连接失败')).toBe(HOST_KEY_HINT)
    expect(hostKeyMessage({ message: 'known_hosts 中不存在该主机' }, '连接失败')).toBe(HOST_KEY_HINT)
    expect(hostKeyMessage({ code: 'fingerprint', message: '证书已重新生成' }, '连接失败')).toBe('证书已重新生成')
    expect(isHostKeyError({ message: '密码错误' })).toBe(false)
    expect(friendlyError({ error: '网络错误' }, '兜底')).toBe('网络错误')
    expect(friendlyError(new Error('x'), '兜底')).toBe('x')
    expect(friendlyError(null, '兜底')).toBe('兜底')
    expect(errorCode({ code: 'unauthorized' })).toBe('unauthorized')
  })
})

describe('目录路径', () => {
  it('Windows 与 POSIX 的上一级、拼接', () => {
    expect(parentPath('D:\\code\\qingcode-next')).toBe('D:\\code')
    expect(parentPath('D:\\code')).toBe('D:\\')
    expect(parentPath('/root/srv')).toBe('/root')
    expect(parentPath('/root')).toBe('/')
    expect(parentPath('C:')).toBeNull()
    expect(joinPath('D:\\code', 'a')).toBe('D:\\code\\a')
    expect(joinPath('/root/', 'a')).toBe('/root/a')
    expect(joinPath('', 'a')).toBe('a')
  })
})

describe('注释拼接（§12）', () => {
  it('引用逐行加前缀、评论可空、多注释之间空行', () => {
    expect(quoteText('a\nb')).toBe('> a\n> b')
    expect(formatQuotedMessage([], '用户消息')).toBe('用户消息')
    expect(formatQuotedMessage([{ id: '1', quote: 'a\nb', comment: '' }], '用户消息')).toBe(
      '> a\n> b\n\n用户消息',
    )
    expect(
      formatQuotedMessage(
        [
          { id: '1', quote: 'x', comment: '请看这里' },
          { id: '2', quote: 'y', comment: '' },
        ],
        '  请修复  ',
      ),
    ).toBe('> x\n请看这里\n\n> y\n\n请修复')
  })
})
