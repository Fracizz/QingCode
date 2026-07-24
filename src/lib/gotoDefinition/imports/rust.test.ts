import { describe, expect, it } from 'vitest'
import { parseRustUsePath } from './rust'

describe('parseRustUsePath', () => {
  it('parses crate path with alias', () => {
    expect(parseRustUsePath('use crate::foo::bar as baz;')).toEqual({
      root: 'crate',
      parts: ['foo', 'bar'],
      alias: 'baz',
    })
  })

  it('parses super path', () => {
    expect(parseRustUsePath('use super::util;')).toEqual({
      root: 'super',
      parts: ['util'],
      alias: undefined,
    })
  })
})
