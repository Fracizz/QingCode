import { describe, expect, it } from 'vitest'
import {
  canShowDefinitionLink,
  codeNavigationAvailabilityForPath,
  isDefinitionLinkEnabledForPath,
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
  it('only enables definition-link affordances for local semantic languages', () => {
    expect(isDefinitionLinkEnabledForPath('D:\\work\\Widget.vue')).toBe(false)
    expect(isDefinitionLinkEnabledForPath('D:\\work\\Widget.VUE')).toBe(false)
    expect(isDefinitionLinkEnabledForPath('D:\\work\\README.md')).toBe(false)
    expect(isDefinitionLinkEnabledForPath('D:\\work\\Makefile')).toBe(false)
    expect(
      isDefinitionLinkEnabledForPath(
        'ssh://23a6efe9-51bb-4121-9d8c-41538a91d6b2/d:/code/qingcode/AGENTS.md'
      )
    ).toBe(false)
    expect(isDefinitionLinkEnabledForPath('SSH://connection/work/Widget.ts')).toBe(false)
    expect(isDefinitionLinkEnabledForPath('D:\\work\\Widget.ts')).toBe(true)
    expect(isDefinitionLinkEnabledForPath('/work/script.PY')).toBe(true)
  })

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
