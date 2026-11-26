import { describe, expect, it } from 'vitest'
import {
  parseBranchRefs,
  parseLog,
  parseNameStatus,
  parseStatus,
  splitNul,
} from './parse'

// 来自 git status --porcelain=v2 -z --branch --untracked-files=all 的真实字节布局。
const STATUS_OUTPUT =
  [
    '# branch.oid 399e91c799402e35598602368a92e5345a81e4fa',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 78981922613b2afb602504 78981922613b2afb602504 a.txt',
    '2 R. N... 100644 100644 100644 61780798228d17af2d34fce4 61780798228d17af2d34fce4 R100 sub/c.txt',
    'sub/b.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt',
    '? untracked space.txt',
    '! ignored.txt',
  ].join('\0') + '\0'

describe('splitNul', () => {
  it('去掉末尾空串，空输入返回空数组', () => {
    expect(splitNul('a\0b\0')).toEqual(['a', 'b'])
    expect(splitNul('')).toEqual([])
  })
})

describe('parseStatus', () => {
  it('解析分支头、ahead/behind 与全部条目类型', () => {
    const status = parseStatus(STATUS_OUTPUT)
    expect(status.branch).toBe('main')
    expect(status.head).toBe('399e91c799402e35598602368a92e5345a81e4fa')
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)
    expect(status.files).toEqual([
      { path: 'a.txt', index: '.', worktree: 'M', conflict: false },
      {
        path: 'sub/c.txt',
        origPath: 'sub/b.txt',
        index: 'R',
        worktree: '.',
        conflict: false,
      },
      { path: 'conflict.txt', index: 'U', worktree: 'U', conflict: true },
      { path: 'untracked space.txt', index: '?', worktree: '?', conflict: false },
      { path: 'ignored.txt', index: '!', worktree: '!', conflict: false },
    ])
  })

  it('空仓库与 detached HEAD', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({
      branch: 'main',
      head: null,
      ahead: 0,
      behind: 0,
      files: [],
    })
    expect(parseStatus('# branch.oid abc\0# branch.head (detached)\0')).toMatchObject({
      branch: null,
      head: 'abc',
    })
  })

  it('pathspec 查询没有头部，未跟踪文件路径可含空格', () => {
    expect(parseStatus('? a b.txt\0? c.txt\0').files).toEqual([
      { path: 'a b.txt', index: '?', worktree: '?', conflict: false },
      { path: 'c.txt', index: '?', worktree: '?', conflict: false },
    ])
  })

  it('重命名记录是最后一条时不会越界', () => {
    const status = parseStatus('2 R. N... 100644 100644 100644 h h R100 new.txt\0')
    expect(status.files[0]).toMatchObject({ path: 'new.txt', index: 'R', worktree: '.' })
  })
})

describe('parseLog', () => {
  // 用 \x00 而不是 \0：后接数字时 \017 会被解析成八进制转义。
  const LOG =
    'aaa\x00bbb ccc\x00Alice\x00a@x\x001795678025\x00second\x1e\n' +
    'bbb\x00\x00Bob\x00b@x\x001795678024\x00init\x1e\n'

  it('NUL 字段 + RS 记录分隔，秒级时间转毫秒', () => {
    expect(parseLog(LOG)).toEqual([
      {
        hash: 'aaa',
        parents: ['bbb', 'ccc'],
        author: 'Alice',
        email: 'a@x',
        date: 1_795_678_025_000,
        subject: 'second',
      },
      {
        hash: 'bbb',
        parents: [],
        author: 'Bob',
        email: 'b@x',
        date: 1_795_678_024_000,
        subject: 'init',
      },
    ])
  })

  it('空输出与非记录片段都忽略', () => {
    expect(parseLog('')).toEqual([])
    expect(parseLog('\n')).toEqual([])
    expect(parseLog('garbage\x1e\n')).toEqual([])
  })
})

describe('parseBranchRefs', () => {
  const REFS =
    [
      'refs/heads/main\0main\0hash1\0origin/main\0*',
      'refs/heads/feature/x\0feature/x\0hash2\0\0',
      'refs/remotes/origin/main\0origin/main\0hash3\0\0',
      'refs/remotes/origin/HEAD\0origin/HEAD\0hash3\0\0',
      'refs/remotes/origin/topic\0origin/topic\0hash4\0\0',
    ].join('\n') + '\n'

  it('分出本地/远端、排除 */HEAD、识别当前分支与 upstream', () => {
    expect(parseBranchRefs(REFS)).toEqual({
      current: 'main',
      local: [
        { name: 'main', head: 'hash1', upstream: 'origin/main' },
        { name: 'feature/x', head: 'hash2' },
      ],
      remote: [
        { name: 'origin/main', head: 'hash3' },
        { name: 'origin/topic', head: 'hash4' },
      ],
    })
  })

  it('空仓库 / detached 没有 HEAD 标记', () => {
    expect(parseBranchRefs('')).toEqual({ current: null, local: [], remote: [] })
    expect(parseBranchRefs('refs/heads/main\0main\0hash1\0\0\n')).toMatchObject({
      current: null,
      local: [{ name: 'main', head: 'hash1' }],
    })
  })
})

describe('parseNameStatus', () => {
  it('普通状态与重命名/复制（原路径在前，新路径在后）', () => {
    expect(
      parseNameStatus('A\0a.txt\0M\0b txt\0R100\0old.txt\0new.txt\0C75\0src.txt\0dst.txt\0D\0gone.txt\0'),
    ).toEqual([
      { path: 'a.txt', status: 'A' },
      { path: 'b txt', status: 'M' },
      { path: 'new.txt', origPath: 'old.txt', status: 'R100' },
      { path: 'dst.txt', origPath: 'src.txt', status: 'C75' },
      { path: 'gone.txt', status: 'D' },
    ])
  })

  it('空输出与残缺记录', () => {
    expect(parseNameStatus('')).toEqual([])
    expect(parseNameStatus('A\0')).toEqual([])
    expect(parseNameStatus('R100\0old.txt\0')).toEqual([])
    expect(parseNameStatus('\0A\0a.txt\0')).toEqual([{ path: 'a.txt', status: 'A' }])
  })
})
