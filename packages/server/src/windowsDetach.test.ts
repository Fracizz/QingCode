import { describe, expect, it } from 'vitest'
import { needsJobBreakaway, windowsCommandLine } from './windowsDetach'

describe('windowsDetach', () => {
  it('只有经 SSH 启动的 Windows 进程需要脱离 job', () => {
    expect(needsJobBreakaway({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, 'win32')).toBe(true)
    expect(needsJobBreakaway({}, 'win32')).toBe(false)
    expect(needsJobBreakaway({ SSH_CONNECTION: 'x' }, 'linux')).toBe(false)
  })

  it('命令行逐个加引号，结尾反斜杠成对，拒绝内嵌引号', () => {
    expect(windowsCommandLine(['C:\\Program Files\\node.exe', 'D:\\'])).toBe(
      '"C:\\Program Files\\node.exe" "D:\\\\"',
    )
    expect(() => windowsCommandLine(['a"b'])).toThrow('双引号')
  })
})
