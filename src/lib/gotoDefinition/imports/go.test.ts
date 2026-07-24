import { describe, expect, it } from 'vitest'
import { parseGoImportLine } from './go'

describe('parseGoImportLine', () => {
  it('parses aliased import', () => {
    expect(parseGoImportLine('import fmt2 "fmt"')).toEqual({
      alias: 'fmt2',
      path: 'fmt',
    })
  })

  it('parses plain import', () => {
    expect(parseGoImportLine('import "net/http"')).toEqual({
      alias: undefined,
      path: 'net/http',
    })
  })
})
