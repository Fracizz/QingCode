import { describe, expect, it } from 'vitest'
import { isIgnored, isSkippedDir, parseIgnore } from './ignore'

describe('遍历跳过的目录', () => {
  it('版本控制/依赖目录大小写不敏感', () => {
    expect(isSkippedDir('.git', 'win32')).toBe(true)
    expect(isSkippedDir('.GIT', 'win32')).toBe(true)
    expect(isSkippedDir('Node_Modules', 'win32')).toBe(true)
    expect(isSkippedDir('.hg', 'linux')).toBe(true)
    expect(isSkippedDir('src', 'win32')).toBe(false)
  })

  it('Windows 系统目录只在 win32 跳过', () => {
    expect(isSkippedDir('$RECYCLE.BIN', 'win32')).toBe(true)
    expect(isSkippedDir('$recycle.bin', 'win32')).toBe(true)
    expect(isSkippedDir('System Volume Information', 'win32')).toBe(true)
    expect(isSkippedDir('system volume information', 'win32')).toBe(true)
    expect(isSkippedDir('$RECYCLE.BIN', 'linux')).toBe(false)
  })
})

describe('.gitignore 简化规则', () => {
  it('解析注释、取反、目录模式、锚定与 CRLF', () => {
    const rules = parseIgnore('# comment\r\ndist/\r\n*.log\r\n!hit-keep.log\r\n/src/generated/**\r\n')
    expect(rules).toEqual([
      { base: '', pattern: 'dist', negate: false, dirOnly: true },
      { base: '', pattern: '*.log', negate: false, dirOnly: false },
      { base: '', pattern: 'hit-keep.log', negate: true, dirOnly: false },
      { base: '', pattern: 'src/generated/**', negate: false, dirOnly: false },
    ])
  })

  it('最后命中的规则生效，目录模式只对目录生效', () => {
    const rules = parseIgnore('dist/\n*.log\n!hit-keep.log\nsrc/generated/**\n')
    expect(isIgnored('dist', true, rules)).toBe(true)
    expect(isIgnored('dist/a.ts', false, rules)).toBe(false) // 父目录已被跳过
    expect(isIgnored('src/a.log', false, rules)).toBe(true)
    expect(isIgnored('hit-keep.log', false, rules)).toBe(false)
    expect(isIgnored('src/generated/a.ts', false, rules)).toBe(true)
    expect(isIgnored('src/a.ts', false, rules)).toBe(false)
  })

  it('嵌套 .gitignore 的规则只作用于所在目录', () => {
    const rules = parseIgnore('hit-secret.ts\n', 'src')
    expect(isIgnored('src/hit-secret.ts', false, rules)).toBe(true)
    expect(isIgnored('hit-secret.ts', false, rules)).toBe(false)
    expect(isIgnored('src/nested/hit-secret.ts', false, rules)).toBe(true)
  })

  it('默认大小写不敏感，caseSensitive 时按字面匹配', () => {
    const rules = parseIgnore('SRC/**\n')
    expect(isIgnored('src/a.ts', false, rules)).toBe(true)
    expect(isIgnored('src/a.ts', false, rules, true)).toBe(false)
    expect(isIgnored('SRC/a.ts', false, rules, true)).toBe(true)
  })
})
