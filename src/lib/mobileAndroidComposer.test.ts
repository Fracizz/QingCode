import { describe, expect, it } from 'vitest'
import { composerInput, isSlashDraft } from '../../mobile/android/web/composer.js'

describe('Android terminal command and skill completion', () => {
  it.each(['/', '/effort', '/plix 验证页面', '/技能'])('previews %s without executing it', value => {
    expect(isSlashDraft(value)).toBe(true)
    expect(composerInput(value, 'submit', true)).toEqual({ data: value, interactive: true })
  })

  it('opens slash candidates with the existing prefix and without a duplicate slash', () => {
    expect(composerInput('', 'slash')).toEqual({ data: '/', interactive: true })
    expect(composerInput('eff', 'slash')).toEqual({ data: '/eff', interactive: true })
    expect(composerInput('/eff', 'slash')).toEqual({ data: '/eff', interactive: true })
  })

  it('transfers the prefix before Tab and leaves confirmation to the user', () => {
    expect(composerInput('/eff', 'complete', true)).toEqual({ data: '/eff\t', interactive: true })
    expect(composerInput('git che', 'complete')).toEqual({ data: 'git che\t', interactive: true })
    expect(composerInput('', 'complete')).toEqual({ data: '\t', interactive: true })
  })

  it.each(['echo a\necho b', '/skill\rnext', '/skill\r\nnext'])('retains multiline drafts during completion: %j', value => {
    expect(isSlashDraft(value)).toBe(false)
    expect(composerInput(value, 'complete')).toBeNull()
    expect(composerInput(value, 'slash')).toBeNull()
  })

  it('keeps ordinary commands, explicit Enter, and multiline bracketed paste working', () => {
    expect(composerInput('echo 中文', 'submit')).toEqual({ data: 'echo 中文\r', interactive: false })
    expect(composerInput('', 'submit')).toEqual({ data: '\r', interactive: false })
    expect(composerInput('a\r\nb', 'submit', true)).toEqual({ data: '\x1b[200~a\rb\x1b[201~\r', interactive: false })
    expect(composerInput('a\nb', 'submit')).toEqual({ data: 'a\rb\r', interactive: false })
  })
})
