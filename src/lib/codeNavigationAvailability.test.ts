import { describe, expect, it } from 'vitest'
import {
  canShowDefinitionLink,
  codeNavigationAvailabilityForPath,
  type LanguageComponentStatus,
} from './codeNavigationAvailability'

const statuses: LanguageComponentStatus[] = [
  {
    id: 'typescript',
    name: 'TypeScript / JavaScript',
    installed: true,
    extensions: ['js', 'jsx', 'ts', 'tsx'],
  },
  {
    id: 'java',
    name: 'Java',
    installed: false,
    extensions: ['java'],
  },
]

describe('codeNavigationAvailabilityForPath', () => {
  it('enables definition links for an installed language component', () => {
    const availability = codeNavigationAvailabilityForPath('D:\\work\\Widget.TSX', statuses)

    expect(availability.kind).toBe('available')
    expect(canShowDefinitionLink(availability)).toBe(true)
  })

  it('identifies a supported language whose component is missing', () => {
    const availability = codeNavigationAvailabilityForPath('D:\\work\\Widget.java', statuses)

    expect(availability).toMatchObject({
      kind: 'missing-component',
      component: { id: 'java', name: 'Java' },
    })
    expect(canShowDefinitionLink(availability)).toBe(false)
  })

  it('keeps unsupported files out of the Ctrl-hover link state', () => {
    expect(codeNavigationAvailabilityForPath('D:\\work\\README.md', statuses)).toEqual({
      kind: 'unsupported',
      extension: 'md',
    })
    expect(codeNavigationAvailabilityForPath('D:\\work\\Makefile', statuses)).toEqual({
      kind: 'unsupported',
      extension: null,
    })
  })
})
