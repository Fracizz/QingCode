import { describe, expect, it } from 'vitest'
import { parseJsImportLine } from './javascript'

describe('parseJsImportLine', () => {
  it('parses named import with alias', () => {
    const info = parseJsImportLine("import { foo as bar } from './mod'")
    expect(info?.specifier).toBe('./mod')
    expect(info?.names).toEqual([{ exported: 'foo', local: 'bar' }])
  })

  it('parses default import', () => {
    const info = parseJsImportLine("import React from 'react'")
    expect(info?.names).toEqual([{ exported: 'default', local: 'React' }])
    expect(info?.specifier).toBe('react')
  })

  it('parses require', () => {
    const info = parseJsImportLine("const fs = require('fs')")
    expect(info?.specifier).toBe('fs')
    expect(info?.names[0]?.local).toBe('fs')
  })
})
