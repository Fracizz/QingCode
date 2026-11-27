import { describe, expect, it } from 'vitest'
import { CliError, parseArgs } from './args'

describe('parseArgs', () => {
  it('解析 version 与默认开关', () => {
    expect(parseArgs(['version'])).toEqual({ command: 'version', replace: false, stdio: false })
  })

  it('支持 --state-dir 两种写法与 --replace', () => {
    expect(parseArgs(['ensure', '--state-dir', 'D:/state', '--replace'])).toEqual({
      command: 'ensure',
      stateDir: 'D:/state',
      replace: true,
      stdio: false,
    })
    expect(parseArgs(['daemon', '--state-dir=/tmp/state'])).toEqual({
      command: 'daemon',
      stateDir: '/tmp/state',
      replace: false,
      stdio: false,
    })
  })

  it('connect 必须带 --stdio', () => {
    expect(parseArgs(['connect', '--stdio'])).toEqual({
      command: 'connect',
      replace: false,
      stdio: true,
    })
    expect(() => parseArgs(['connect'])).toThrowError(CliError)
  })

  it('拒绝未知命令、未知参数与错位的开关', () => {
    expect(() => parseArgs([])).toThrowError(CliError)
    expect(() => parseArgs(['nope'])).toThrowError(CliError)
    expect(() => parseArgs(['version', '--oops'])).toThrowError(CliError)
    expect(() => parseArgs(['daemon', '--replace'])).toThrowError(CliError)
    expect(() => parseArgs(['version', '--stdio'])).toThrowError(CliError)
    expect(() => parseArgs(['ensure', '--state-dir'])).toThrowError(CliError)
    expect(() => parseArgs(['ensure', '--state-dir', '--replace'])).toThrowError(CliError)
  })
})
