import { describe, expect, it } from 'vitest'
import { IMAGE_EXTENSIONS, IMAGE_MAX_BYTES, isImagePath, mimeForImage } from './imageFiles'

describe('isImagePath', () => {
  it('matches every whitelisted extension', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(isImagePath(`icons/logo.${ext}`)).toBe(true)
    }
  })

  it('matches local Windows paths and ssh:// resource identifiers', () => {
    expect(isImagePath('D:\\Code\\assets\\logo.png')).toBe(true)
    expect(isImagePath('ssh://c1/home/app/docs/diagram.webp')).toBe(true)
  })

  it('ignores extension case and trailing dots in names', () => {
    expect(isImagePath('PHOTO.JPG')).toBe(true)
    expect(isImagePath('D:\\a\\b.AvIf')).toBe(true)
    expect(isImagePath('icon.ico')).toBe(true)
  })

  it('rejects tif/tiff, non-image extensions and extensionless names', () => {
    expect(isImagePath('scan.tiff')).toBe(false)
    expect(isImagePath('scan.TIF')).toBe(false)
    expect(isImagePath('notes.md')).toBe(false)
    expect(isImagePath('archive.tar.gz')).toBe(false)
    expect(isImagePath('.png')).toBe(false)
    expect(isImagePath('README')).toBe(false)
    expect(isImagePath('')).toBe(false)
  })
})

describe('mimeForImage', () => {
  it('maps extensions (case-insensitive) to MIME types', () => {
    expect(mimeForImage('a/b.png')).toBe('image/png')
    expect(mimeForImage('PHOTO.JPG')).toBe('image/jpeg')
    expect(mimeForImage('pic.jpeg')).toBe('image/jpeg')
    expect(mimeForImage('anim.gif')).toBe('image/gif')
    expect(mimeForImage('shot.webp')).toBe('image/webp')
    expect(mimeForImage('legacy.bmp')).toBe('image/bmp')
    expect(mimeForImage('favicon.ico')).toBe('image/x-icon')
    expect(mimeForImage('next-gen.AVIF')).toBe('image/avif')
  })

  it('falls back to octet-stream outside the whitelist', () => {
    expect(mimeForImage('scan.tiff')).toBe('application/octet-stream')
    expect(mimeForImage('no-extension')).toBe('application/octet-stream')
  })
})

describe('IMAGE_MAX_BYTES', () => {
  it('is the 64MB frontend cap', () => {
    expect(IMAGE_MAX_BYTES).toBe(64 * 1024 * 1024)
  })
})
