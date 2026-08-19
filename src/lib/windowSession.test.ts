// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('windowSession', () => {
  it('marks an Explorer-launched window as external and skips workspace restore', async () => {
    window.history.replaceState(null, '', '/?fresh=1&external=1')
    const session = await import('./windowSession')

    session.initWindowSession()

    expect(session.isExternalFileWindow()).toBe(true)
    expect(session.shouldRestoreWorkspace()).toBe(false)
    expect(window.location.search).toBe('')
  })

  it('keeps a regular main window eligible for workspace restore', async () => {
    const session = await import('./windowSession')

    session.initWindowSession()

    expect(session.isExternalFileWindow()).toBe(false)
    expect(session.shouldRestoreWorkspace()).toBe(true)
  })
})
