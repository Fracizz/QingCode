import { fileExtension } from './openFileError'

/**
 * Image formats the editor can render in a tab. Single source of truth for
 * the frontend; keep in sync with the Rust `read_image_file` whitelist.
 * `tif` / `tiff` are intentionally excluded (WebView2 cannot render them).
 */
export const IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
]

/** Frontend mirror of the backend read_image_file cap, used for early friendly errors. */
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/** Whether the path's extension is a renderable image (case-insensitive). */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(fileExtension(path))
}

/** MIME type for a whitelisted image path; octet-stream as a defensive fallback. */
export function mimeForImage(path: string): string {
  return IMAGE_MIME_BY_EXTENSION[fileExtension(path)] ?? 'application/octet-stream'
}
