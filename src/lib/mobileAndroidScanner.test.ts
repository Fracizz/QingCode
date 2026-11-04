import { describe, expect, it, vi } from 'vitest'
import { focusScannerCamera, requestScannerCamera, scannerRegions } from '../../mobile/android/web/scanner.js'

describe('Android scanner camera', () => {
  it('requests the high-resolution rear camera without microphone access', async () => {
    const stream = {}
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    expect(await requestScannerCamera({ getUserMedia })).toBe(stream)
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } },
      audio: false,
    })
  })

  it('falls back for unsupported constraints and preserves permission errors', async () => {
    const getUserMedia = vi.fn().mockRejectedValueOnce({ name: 'OverconstrainedError' }).mockResolvedValueOnce('camera')
    expect(await requestScannerCamera({ getUserMedia })).toBe('camera')
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: { facingMode: 'environment' }, audio: false })
    getUserMedia.mockReset().mockRejectedValue({ name: 'NotAllowedError' })
    await expect(requestScannerCamera({ getUserMedia })).rejects.toEqual({ name: 'NotAllowedError' })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('enables continuous focus only when supported and tolerates camera rejection', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined)
    const track = { getCapabilities: () => ({ focusMode: ['manual', 'continuous'] }), applyConstraints }
    await focusScannerCamera({ getVideoTracks: () => [track] })
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] })
    applyConstraints.mockReset().mockRejectedValue(new Error('unsupported'))
    await expect(focusScannerCamera({ getVideoTracks: () => [track] })).resolves.toBeUndefined()
    applyConstraints.mockReset()
    await focusScannerCamera({ getVideoTracks: () => [{ getCapabilities: () => ({}) }] })
    expect(applyConstraints).not.toHaveBeenCalled()
  })

  it.each([[1920, 1080], [1080, 1920], [640, 480], [3840, 2160]])('retains QR detail at %sx%s and covers the full frame', (width, height) => {
    const regions = scannerRegions(width, height)
    const center = regions[0]
    expect(center.targetWidth).toBe(Math.min(1280, width, height))
    expect(center.targetHeight).toBe(center.targetWidth)
    expect(center.x + center.width / 2).toBe(width / 2)
    expect(center.y + center.height / 2).toBe(height / 2)
    expect(regions.at(-1)).toMatchObject({ x: 0, y: 0, width, height })
    for (const region of regions) {
      expect(region.targetWidth).toBeLessThanOrEqual(region.width)
      expect(region.targetHeight).toBeLessThanOrEqual(region.height)
    }
  })

  it('waits for video dimensions and avoids duplicate square samples', () => {
    expect(scannerRegions(0, 0)).toEqual([])
    expect(scannerRegions(720, 720)).toHaveLength(1)
  })
})
