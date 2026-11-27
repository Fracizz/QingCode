import { beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../../../shared/backendApi'
import { isCwdUntrusted, isPathUntrusted, useProjectTrust } from './projectTrust'

const project = (path: string, trusted: boolean): Project =>
  ({ id: path, targetId: 't', name: path, path, lastOpenedAt: 0, trusted })

describe('isPathUntrusted', () => {
  it('匹配项目根与子目录，不误伤同前缀目录', () => {
    expect(isPathUntrusted(['/srv/app'], '/srv/app')).toBe(true)
    expect(isPathUntrusted(['/srv/app'], '/srv/app/sub/')).toBe(true)
    expect(isPathUntrusted(['/srv/app'], '/srv/app2')).toBe(false)
    expect(isPathUntrusted(['/srv/app'], null)).toBe(false)
  })

  it('Windows 路径忽略大小写与分隔符差异', () => {
    expect(isPathUntrusted(['D:\\Code\\App'], 'd:/code/app/src')).toBe(true)
  })
})

describe('useProjectTrust', () => {
  beforeEach(() => useProjectTrust.setState({ untrustedByTarget: {} }))

  it('只收录未信任项目，按目标隔离', () => {
    useProjectTrust.getState().setTargetProjects('t', [project('/a', false), project('/b', true)])
    expect(isCwdUntrusted('t', '/a')).toBe(true)
    expect(isCwdUntrusted('t', '/b')).toBe(false)
    expect(isCwdUntrusted('other', '/a')).toBe(false)
  })
})
