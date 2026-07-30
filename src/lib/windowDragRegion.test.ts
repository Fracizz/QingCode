import { describe, expect, it } from 'vitest'
import { resolveWindowDragRegionMode } from './windowDragRegion'

describe('resolveWindowDragRegionMode', () => {
  it('uses native non-client regions on modern WebView2', () => {
    expect(
      resolveWindowDragRegionMode(
        true,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/123.0.0.0'
      )
    ).toBe('native')
    expect(
      resolveWindowDragRegionMode(
        true,
        'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 Edg/140.0.0.0'
      )
    ).toBe('native')
  })

  it('keeps the Tauri fallback for old or unidentifiable Windows runtimes', () => {
    expect(
      resolveWindowDragRegionMode(
        true,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/122.0.0.0'
      )
    ).toBe('tauri-fallback')
    expect(resolveWindowDragRegionMode(true, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(
      'tauri-fallback'
    )
  })

  it('keeps Tauri fallback on other desktop engines and disables drag in browser preview', () => {
    expect(resolveWindowDragRegionMode(true, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      'tauri-fallback'
    )
    expect(
      resolveWindowDragRegionMode(false, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140.0.0.0')
    ).toBe('none')
  })
})
