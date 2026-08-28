import { describe, expect, it } from 'vitest'
import {
  EXPLORER_FAVORITES_SECTION,
  EXPLORER_HEADING_LABEL,
  EXPLORER_HEADING_ROW,
} from './explorerLayout'

describe('explorerLayout', () => {
  it('keeps the project name row from shrinking under the favorites card', () => {
    expect(EXPLORER_HEADING_ROW.split(' ')).toEqual(
      expect.arrayContaining(['flex', 'h-9', 'shrink-0', 'items-center']),
    )
    expect(EXPLORER_FAVORITES_SECTION.split(' ')).toContain('flex-shrink-0')
  })

  it('does not use leading-none on truncated explorer labels', () => {
    expect(EXPLORER_HEADING_LABEL.split(' ')).toEqual(
      expect.arrayContaining(['truncate', 'leading-tight']),
    )
    expect(EXPLORER_HEADING_LABEL).not.toContain('leading-none')
  })
})
