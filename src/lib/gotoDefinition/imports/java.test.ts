import { describe, expect, it } from 'vitest'
import { parseJavaImportLine } from './java'

describe('parseJavaImportLine', () => {
  it('parses type import', () => {
    expect(parseJavaImportLine('import com.example.Foo;')).toEqual({
      dotted: 'com.example.Foo',
      static: false,
    })
  })

  it('parses static import', () => {
    expect(parseJavaImportLine('import static java.util.Objects.requireNonNull;')).toMatchObject({
      dotted: 'java.util.Objects.requireNonNull',
      static: true,
    })
  })
})
