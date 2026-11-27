import { describe, expect, it } from 'vitest'
import {
  baseName,
  canGoBack,
  canGoForward,
  currentPath,
  defaultProjectName,
  goBack,
  goForward,
  goUp,
  initHistory,
  joinPath,
  navigateTo,
  normalizePath,
  parentPath,
  parseFsList,
} from './directory'

describe('路径运算', () => {
  it('保留 Windows 与 POSIX 根目录', () => {
    expect(normalizePath('/home/user/')).toBe('/home/user')
    expect(normalizePath('C:\\Users\\')).toBe('C:\\Users')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('C:\\')).toBe('C:\\')
    expect(normalizePath('  ')).toBe('')
  })

  it('按已有分隔符拼接子目录', () => {
    expect(joinPath('/', 'home')).toBe('/home')
    expect(joinPath('/home', 'alice')).toBe('/home/alice')
    expect(joinPath('C:\\', 'Users')).toBe('C:\\Users')
    expect(joinPath('C:\\Users', 'repo')).toBe('C:\\Users\\repo')
    expect(joinPath('', 'repo')).toBe('repo')
  })

  it('求上级目录且不越过根', () => {
    expect(parentPath('/home/alice')).toBe('/home')
    expect(parentPath('/home')).toBe('/')
    expect(parentPath('/')).toBe('/')
    expect(parentPath('C:\\Users\\alice')).toBe('C:\\Users')
    expect(parentPath('C:\\Users')).toBe('C:\\')
    expect(parentPath('C:\\')).toBe('C:\\')
    expect(parentPath('repo')).toBe('')
  })

  it('取目录名作为项目默认名', () => {
    expect(baseName('/home/alice/repo')).toBe('repo')
    expect(baseName('C:\\work\\repo\\')).toBe('repo')
    expect(defaultProjectName('/')).toBe('/')
    expect(defaultProjectName('')).toBe('未命名项目')
  })

  it('解析 fs.list 并按名称排序', () => {
    expect(
      parseFsList({
        path: '/home',
        entries: [
          { name: 'z', kind: 'dir' },
          { name: 'a', kind: 'symlink' },
          { name: 'bad', kind: 3 },
          null,
        ],
      }),
    ).toEqual({
      path: '/home',
      entries: [
        { name: 'a', kind: 'symlink' },
        { name: 'bad', kind: 'file' },
        { name: 'z', kind: 'dir' },
      ],
    })
    expect(parseFsList(null)).toEqual({ path: '', entries: [] })
  })
})

describe('目录历史', () => {
  it('前进后退与上级', () => {
    let history = initHistory('/home')
    expect(currentPath(history)).toBe('/home')
    expect(canGoBack(history)).toBe(false)

    history = navigateTo(history, joinPath('/home', 'alice'))
    history = navigateTo(history, joinPath('/home/alice', 'repo'))
    expect(currentPath(history)).toBe('/home/alice/repo')
    expect(canGoBack(history)).toBe(true)
    expect(canGoForward(history)).toBe(false)

    expect(currentPath(goBack(history))).toBe('/home/alice')
    expect(currentPath(goBack(goBack(history)))).toBe('/home')
    expect(currentPath(goForward(goBack(history)))).toBe('/home/alice/repo')
    expect(currentPath(goUp(history))).toBe('/home/alice')
    expect(currentPath(goUp(initHistory('/')))).toBe('/')
  })

  it('回退后再进入新目录会丢弃前进分支，重复路径不新增记录', () => {
    let history = initHistory('/a')
    history = navigateTo(history, '/a/b')
    history = navigateTo(history, '/a/b/c')
    history = goBack(history)
    history = navigateTo(history, '/a/x')
    expect(history.entries).toEqual(['/a', '/a/b', '/a/x'])
    expect(history.index).toBe(2)
    expect(canGoForward(history)).toBe(false)

    const unchanged = navigateTo(history, '/a/x')
    expect(unchanged).toBe(history)
  })
})
