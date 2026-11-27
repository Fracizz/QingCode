import { describe, expect, it } from 'vitest'
import {
  toWorkspaceRoot,
  baseName,
  collapseAll,
  createTreeState,
  describeWorkspaceError,
  detectPathStyle,
  dirsToRefresh,
  filterEntries,
  isExpanded,
  isHiddenName,
  isSamePath,
  isWithinPath,
  joinPath,
  parentPath,
  parseListResult,
  pruneDirs,
  relativePath,
  setDirError,
  setDirLoading,
  setDirReady,
  setShowHidden,
  sortEntries,
  toggleExpanded,
  validateEntryName,
  visibleRows,
  withDraft,
  workspaceErrorMessage,
  type ExplorerEntry,
  type TreeState,
} from './treeModel'

const entries = (...items: Array<[string, ExplorerEntry['kind']]>): ExplorerEntry[] =>
  items.map(([name, kind]) => ({ name, kind }))

describe('路径运算', () => {
  it('旧版 SFTP 盘符路径转成 Windows 本机路径', () => {
    expect(toWorkspaceRoot('/D:/code/qingcode-next')).toBe('D:\\code\\qingcode-next')
    expect(toWorkspaceRoot('/D:/')).toBe('D:\\')
    expect(toWorkspaceRoot('D:\\code')).toBe('D:\\code')
    expect(toWorkspaceRoot('/home/me/repo')).toBe('/home/me/repo')
  })

  it('按 root 推断 POSIX / Windows 风格', () => {
    expect(detectPathStyle('/home/user/repo')).toBe('posix')
    expect(detectPathStyle('C:\\Users\\repo')).toBe('windows')
    expect(detectPathStyle('C:/Users/repo')).toBe('windows')
    expect(detectPathStyle('\\\\server\\share\\repo')).toBe('windows')
  })

  it('拼接时保留 root 风格且不产生重复分隔符', () => {
    expect(joinPath('/', 'home')).toBe('/home')
    expect(joinPath('/home/user/', 'repo')).toBe('/home/user/repo')
    expect(joinPath('C:\\', 'Users')).toBe('C:\\Users')
    expect(joinPath('C:\\Users\\repo', 'src')).toBe('C:\\Users\\repo\\src')
    expect(joinPath('C:/Users/repo', 'src')).toBe('C:/Users/repo/src')
    expect(joinPath('\\\\server\\share\\', 'repo')).toBe('\\\\server\\share\\repo')
  })

  it('求上级目录且不越过根目录', () => {
    expect(parentPath('/home/user/a.ts')).toBe('/home/user')
    expect(parentPath('/home/')).toBe('/')
    expect(parentPath('/')).toBe('/')
    expect(parentPath('C:\\Users\\a.ts')).toBe('C:\\Users')
    expect(parentPath('C:\\Users')).toBe('C:\\')
    expect(parentPath('C:\\')).toBe('C:\\')
  })

  it('取文件名与相对路径', () => {
    expect(baseName('/home/user/a.ts')).toBe('a.ts')
    expect(baseName('C:\\Users\\repo\\a.ts')).toBe('a.ts')
    expect(relativePath('/home/user', '/home/user/src/a.ts')).toBe('src/a.ts')
    expect(relativePath('C:\\Users\\repo', 'C:\\Users\\repo\\src\\a.ts')).toBe('src\\a.ts')
    expect(relativePath('C:/Users/repo', 'C:\\Users\\repo\\a.ts')).toBe('a.ts')
    expect(relativePath('/home/user', '/home/user')).toBe('')
    expect(relativePath('/home/user', '/etc/a.ts')).toBe('/etc/a.ts')
  })

  it('Windows 路径比较忽略大小写，POSIX 区分大小写', () => {
    expect(isSamePath('C:\\Repo\\A.ts', 'c:/repo/a.ts', 'windows')).toBe(true)
    expect(isWithinPath('c:/repo/src/a.ts', 'C:\\Repo', 'windows')).toBe(true)
    expect(isSamePath('/Repo/A.ts', '/repo/a.ts', 'posix')).toBe(false)
    expect(isWithinPath('/repo2/a.ts', '/repo', 'posix')).toBe(false)
    expect(isWithinPath('/repo/a.ts', '/repo', 'posix')).toBe(true)
    expect(isWithinPath('/repo', '/repo', 'posix')).toBe(false)
  })
})

describe('排序与隐藏', () => {
  it('目录在前，名称自然排序且大小写不敏感', () => {
    const sorted = sortEntries(
      entries(
        ['b.ts', 'file'],
        ['a10.ts', 'file'],
        ['Z', 'dir'],
        ['a2.ts', 'file'],
        ['link', 'symlink'],
        ['A', 'dir'],
      ),
    )
    expect(sorted.map((item) => item.name)).toEqual([
      'A',
      'Z',
      'link',
      'a2.ts',
      'a10.ts',
      'b.ts',
    ])
  })

  it('默认隐藏 .git 等点文件，可切换显示', () => {
    const hidden = entries(['.git', 'dir'], ['.env', 'file'], ['src', 'dir'])
    expect(isHiddenName('.git')).toBe(true)
    expect(filterEntries(hidden, false).map((item) => item.name)).toEqual(['src'])
    expect(filterEntries(hidden, true).map((item) => item.name)).toEqual([
      '.git',
      'src',
      '.env',
    ])
  })

  it('解析 fs.list 响应并标记 2000 条截断', () => {
    const parsed = parseListResult({
      path: '/root',
      entries: [{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'weird' }, null],
    })
    expect(parsed.path).toBe('/root')
    expect(parsed.entries).toEqual([
      { name: 'a', kind: 'dir' },
      { name: 'b', kind: 'file' },
    ])
    expect(parsed.truncated).toBe(false)
    expect(parseListResult(null)).toEqual({ path: '', entries: [], truncated: false })
    const many = Array.from({ length: 2000 }, (_, i) => ({ name: `f${i}`, kind: 'file' }))
    expect(parseListResult({ path: '/root', entries: many }).truncated).toBe(true)
  })
})

describe('树状态', () => {
  it('展开/折叠/全部折叠与持久化集合', () => {
    let tree = createTreeState()
    expect(tree.showHidden).toBe(false)
    expect(isExpanded(tree, '/root/src')).toBe(false)
    tree = toggleExpanded(tree, '/root/src')
    tree = toggleExpanded(tree, '/root/src/lib')
    expect(tree.expanded).toEqual(['/root/src', '/root/src/lib'])
    tree = toggleExpanded(tree, '/root/src')
    expect(tree.expanded).toEqual(['/root/src/lib'])
    expect(collapseAll(tree).expanded).toEqual([])
    expect(setShowHidden(tree, true).showHidden).toBe(true)
  })

  it('目录加载中/错误/就绪三种状态的可见行', () => {
    let tree: TreeState = createTreeState()
    expect(visibleRows(tree, '/root')).toMatchObject([{ kind: 'placeholder', message: '尚未加载' }])

    tree = setDirLoading(tree, '/root')
    expect(visibleRows(tree, '/root')[0]?.message).toBe('加载中…')

    tree = setDirError(tree, '/root', '没有权限')
    expect(visibleRows(tree, '/root')[0]?.message).toBe('加载失败：没有权限')

    tree = setDirReady(tree, '/root', entries(['src', 'dir'], ['a.ts', 'file'], ['.git', 'dir']))
    const rows = visibleRows(tree, '/root')
    expect(rows.map((row) => row.name)).toEqual(['src', 'a.ts'])
    expect(rows[0]).toMatchObject({ depth: 0, kind: 'dir', expanded: false })
  })

  it('展开目录后递归扁平化并标出深度', () => {
    let tree = createTreeState(true)
    tree = setDirReady(tree, '/root', entries(['src', 'dir'], ['README.md', 'file']))
    tree = setDirReady(tree, '/root/src', entries(['index.ts', 'file']))
    tree = toggleExpanded(tree, '/root/src')
    expect(visibleRows(tree, '/root').map((row) => [row.name, row.depth])).toEqual([
      ['src', 0],
      ['index.ts', 1],
      ['README.md', 0],
    ])
  })

  it('重命名/删除后剪掉该目录及后代的缓存与展开状态', () => {
    let tree = createTreeState()
    tree = setDirReady(tree, '/root', entries(['src', 'dir']))
    tree = setDirReady(tree, '/root/src', entries(['a.ts', 'file']))
    tree = setDirReady(tree, '/root/src/lib', entries(['b.ts', 'file']))
    tree = toggleExpanded(tree, '/root/src')
    tree = toggleExpanded(tree, '/root/src/lib')
    const pruned = pruneDirs(tree, '/root/src')
    expect(Object.keys(pruned.dirs).sort()).toEqual(['/root'])
    expect(pruned.expanded).toEqual([])
  })

  it('行内输入框插到父目录之后 / 原位替换', () => {
    let tree = createTreeState()
    tree = setDirReady(tree, '/root', entries(['src', 'dir'], ['a.ts', 'file']))
    const rows = visibleRows(tree, '/root')
    const created = withDraft(rows, { mode: 'create', parent: '/root/src', kind: 'file' }, '/root')
    expect(created[1]).toMatchObject({ kind: 'draft', depth: 1 })
    const rootCreated = withDraft(rows, { mode: 'create', parent: '/root', kind: 'dir' }, '/root')
    expect(rootCreated[0]).toMatchObject({ kind: 'draft', depth: 0 })
    const renamed = withDraft(rows, { mode: 'rename', path: '/root/a.ts' }, '/root')
    expect(renamed[1]).toMatchObject({ kind: 'draft', depth: 0 })
    expect(withDraft(rows, null, '/root').every((row) => row.kind === 'node')).toBe(true)
  })
})

describe('fs.changed → 待刷新目录', () => {
  it('文件变化只刷新其父目录与变化目录自身', () => {
    expect(
      dirsToRefresh(
        '/root',
        ['/root', '/root/src', '/root/docs'],
        ['/root/src'],
        ['/root/src/a.ts'],
      ),
    ).toEqual(['/root/src'])
    expect(
      dirsToRefresh('/root', ['/root', '/root/src'], [], ['/root/src']),
    ).toEqual(['/root', '/root/src'])
  })

  it('目录被整体替换时刷新其已加载后代', () => {
    expect(
      dirsToRefresh(
        '/root',
        ['/root', '/root/src', '/root/src/lib', '/root/docs'],
        ['/root/src'],
        ['/root/src'],
      ),
    ).toEqual(['/root', '/root/src', '/root/src/lib'])
  })

  it('忽略 root 之外的变化，但 root 祖先变化时全量刷新', () => {
    const loaded = ['/root', '/root/src']
    expect(dirsToRefresh('/root', loaded, [], ['/other/a.ts'])).toEqual([])
    expect(dirsToRefresh('/root/src', loaded, [], ['/root'])).toEqual(['/root', '/root/src'])
  })

  it('Windows 变化路径大小写/分隔符不同也能命中', () => {
    expect(
      dirsToRefresh(
        'C:\\Repo',
        ['C:\\Repo', 'C:\\Repo\\src'],
        [],
        ['c:/repo/SRC/a.ts'],
      ),
    ).toEqual(['C:\\Repo\\src'])
  })
})

describe('名称校验与错误文案', () => {
  it('禁止空名、路径分隔符、. 与 ..', () => {
    expect(validateEntryName('', 'posix')).toBe('名称不能为空')
    expect(validateEntryName('   ', 'posix')).toBe('名称不能为空')
    expect(validateEntryName('a/b', 'posix')).toContain('路径分隔符')
    expect(validateEntryName('a\\b', 'windows')).toContain('路径分隔符')
    expect(validateEntryName('.', 'posix')).toContain('. 或 ..')
    expect(validateEntryName('..', 'posix')).toContain('. 或 ..')
    expect(validateEntryName('a\u0000b', 'posix')).toContain('控制字符')
  })

  it('Windows 风格额外禁止 NTFS 保留字符，POSIX 允许', () => {
    expect(validateEntryName('a:b.ts', 'windows')).toContain('< >')
    expect(validateEntryName('a?b', 'windows')).toContain('< >')
    expect(validateEntryName('a:b.ts', 'posix')).toBe(null)
    expect(validateEntryName('正常文件.ts', 'windows')).toBe(null)
  })

  it('错误码转中文，未知码回退原始信息', () => {
    expect(workspaceErrorMessage('exists')).toBe('同名文件或目录已存在')
    expect(workspaceErrorMessage('not_found')).toBe('文件或目录不存在')
    expect(workspaceErrorMessage('weird', '远端报错')).toBe('远端报错')
    expect(workspaceErrorMessage('weird')).toBe('操作失败')
    expect(describeWorkspaceError({ code: 'exists' }, '新建文件失败')).toBe(
      '新建文件失败：同名文件或目录已存在',
    )
    expect(describeWorkspaceError(new Error('连接断开'), '读取目录失败')).toBe(
      '读取目录失败：连接断开',
    )
    expect(describeWorkspaceError({ message: 'rg 未安装' }, '搜索失败')).toBe(
      '搜索失败：rg 未安装',
    )
    expect(describeWorkspaceError({ code: 'weird' }, '删除失败')).toBe('删除失败：操作失败')
  })
})
