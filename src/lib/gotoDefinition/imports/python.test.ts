import { describe, expect, it } from 'vitest'
import { parsePythonImportLine } from './python'

describe('parsePythonImportLine', () => {
  it('parses from-import with alias', () => {
    const info = parsePythonImportLine('from app.utils import helper as h')
    expect(info).toEqual({
      kind: 'from',
      relative: 0,
      module: 'app.utils',
      names: [{ exported: 'helper', local: 'h' }],
    })
  })

  it('parses relative from-import', () => {
    const info = parsePythonImportLine('from ..models import User')
    expect(info).toMatchObject({
      kind: 'from',
      relative: 2,
      module: 'models',
      names: [{ exported: 'User', local: 'User' }],
    })
  })

  it('parses import module as alias', () => {
    const info = parsePythonImportLine('import os.path as osp')
    expect(info).toEqual({
      kind: 'import',
      modules: [{ dotted: 'os.path', alias: 'osp' }],
    })
  })
})
