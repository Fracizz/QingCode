import { describe, expect, it } from 'vitest'
import { composerInput, editDraft, isSlashDraft } from '../../mobile/android/web/composer.js'

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

describe('Android local draft editing', () => {
  it.each(['中', '😀', 'e\u0301', '👨‍👩‍👧‍👦'])('backspaces a complete grapheme: %s', character => {
    const value = '前' + character + '后'
    expect(editDraft(value, 1 + character.length, 1 + character.length, 'backspace'))
      .toEqual({ value: '前后', start: 1, end: 1 })
  })

  it('deletes selected text and preserves the rest', () => {
    expect(editDraft('/skill 参数', 1, 6, 'backspace')).toEqual({ value: '/ 参数', start: 1, end: 1 })
    expect(editDraft('hello', 0, 0, 'backspace')).toEqual({ value: 'hello', start: 0, end: 0 })
    expect(editDraft('a😀b', 2, 2, 'backspace')).toEqual({ value: 'ab', start: 1, end: 1 })
  })

  it('moves the caret across a whole emoji and collapses a selection', () => {
    expect(editDraft('a😀b', 1, 1, 'right').start).toBe(3)
    expect(editDraft('a😀b', 3, 3, 'left').start).toBe(1)
    expect(editDraft('a😀b', 1, 3, 'left').start).toBe(1)
    expect(editDraft('a😀b', 1, 3, 'right').start).toBe(3)
  })

  it('deletes only the previous word or the current line prefix', () => {
    expect(editDraft('hello world ', 12, 12, 'delete-word').value).toBe('hello ')
    expect(editDraft('   ', 3, 3, 'delete-word').value).toBe('')
    expect(editDraft('第一行\n前缀后缀', 7, 7, 'delete-line-start').value).toBe('第一行\n缀')
    expect(editDraft('\ntext', 0, 0, 'delete-line-start').value).toBe('\ntext')
  })

  it('inserts symbols and newlines at the selection and clears only the supplied draft', () => {
    expect(editDraft('abc', 1, 2, 'text', '@').value).toBe('a@c')
    expect(editDraft('abc', 1, 2, 'newline').value).toBe('a\nc')
    expect(editDraft('abc', 1, 2, 'clear')).toEqual({ value: '', start: 0, end: 0 })
    expect(composerInput('查 @src', 'preview')).toEqual({ data: '查 @src', interactive: true })
  })
})
