import { describe, expect, it } from 'vitest'
import { sshRootUri } from './sshWorkspace'

describe('sshRootUri', () => {
  it('builds a stable provider URI from a POSIX root', () => {
    expect(sshRootUri('connection-id', '/Home/User/App/')).toBe('ssh://connection-id/Home/User/App')
  })

  it('normalizes separators without lowercasing Linux paths', () => {
    expect(sshRootUri('connection-id', '\\Home\\User\\Foo.ts')).toBe(
      'ssh://connection-id/Home/User/Foo.ts'
    )
  })

  it('keeps the POSIX root slash', () => {
    expect(sshRootUri('connection-id', '/')).toBe('ssh://connection-id/')
  })
})
