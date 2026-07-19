import { describe, expect, it } from 'vitest'
import { isVolatileWatcherTreePath } from './watcherTreeRefresh'

describe('isVolatileWatcherTreePath', () => {
  it('skips Cargo target and node_modules churn', () => {
    expect(
      isVolatileWatcherTreePath(
        'D:\\WorkSpace\\code\\qing-code\\src-tauri\\target\\debug\\deps\\rmetawvl1Na',
      ),
    ).toBe(true)
    expect(
      isVolatileWatcherTreePath(
        'D:/repo/src-tauri/target/debug/deps/rustcJ8UDd9/lib.rlib',
      ),
    ).toBe(true)
    expect(isVolatileWatcherTreePath('D:/proj/node_modules/.pnpm/foo')).toBe(true)
    expect(isVolatileWatcherTreePath('D:/proj/.git/objects/ab')).toBe(true)
  })

  it('allows normal source paths', () => {
    expect(isVolatileWatcherTreePath('D:/WorkSpace/code/qing-code/src/App.tsx')).toBe(false)
    expect(isVolatileWatcherTreePath('D:/proj/src-tauri/src/lib.rs')).toBe(false)
  })
})
