import { describe, expect, it } from 'vitest'
import { chatCommandQuery, exactChatCommand } from './chatCommands'

describe('斜杠命令匹配', () => {
  it('支持带冒号、点和下划线的原生命令名', () => {
    expect(chatCommandQuery('/skill:Deploy')).toBe('skill:deploy')
    expect(chatCommandQuery('  /plugin:do_it.now')).toBe('plugin:do_it.now')
    expect(chatCommandQuery('/')).toBe('')
  })

  it('路径和带参数的正文不是命令查询', () => {
    expect(chatCommandQuery('/usr/bin')).toBeUndefined()
    expect(chatCommandQuery('/review 看一下')).toBeUndefined()
    expect(chatCommandQuery('看看 /tmp')).toBeUndefined()
  })

  it('放宽后仍只有内置命令按本地命令执行', () => {
    expect(exactChatCommand('/help')?.name).toBe('help')
    expect(exactChatCommand('/skill:help')).toBeUndefined()
    expect(exactChatCommand('/help.')).toBeUndefined()
  })
})
