/** Format process RSS bytes for the status bar (e.g. `580 MB`). */
export function formatAppMemoryMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 10) return `${mb.toFixed(1)} MB`
  return `${Math.round(mb)} MB`
}
