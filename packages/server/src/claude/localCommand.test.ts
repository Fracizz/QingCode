import { describe, expect, it } from 'vitest'
import { parseLocalCommand } from './localCommand'

describe('parseLocalCommand', () => {
  it('还原命令、输出并跳过说明', () => {
    expect(parseLocalCommand('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>sonnet</command-args>'))
      .toEqual({ kind: 'command', text: '/model sonnet' })
    expect(parseLocalCommand([{ type: 'text', text: '<command-name>/clear</command-name><command-args></command-args>' }]))
      .toEqual({ kind: 'command', text: '/clear' })
    expect(parseLocalCommand('<local-command-stdout>Set model to \u001b[1msonnet\u001b[22m</local-command-stdout>'))
      .toEqual({ kind: 'output', text: 'Set model to sonnet' })
    expect(parseLocalCommand('<local-command-stdout></local-command-stdout>')).toEqual({ kind: 'skip' })
    expect(parseLocalCommand('<local-command-caveat>Caveat: ...</local-command-caveat>')).toEqual({ kind: 'skip' })
  })

  it('普通消息不处理', () => {
    expect(parseLocalCommand('解释一下 <command-name> 标签')).toBeUndefined()
    expect(parseLocalCommand('<div>html</div>')).toBeUndefined()
    expect(parseLocalCommand([{ type: 'text', text: '<command-name>/x</command-name>' }, { type: 'image' }])).toBeUndefined()
  })
})
