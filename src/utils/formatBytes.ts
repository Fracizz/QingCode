const KB = 1024
const MB = KB * 1024
const GB = MB * 1024
const TB = GB * 1024

/** Human-readable byte size: B / KB under 1MB; MB/GB/TB as xx.xx above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < KB) return `${Math.round(bytes)} B`
  if (bytes < MB) {
    const kb = bytes / KB
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  if (bytes < GB) return `${(bytes / MB).toFixed(2)} MB`
  if (bytes < TB) return `${(bytes / GB).toFixed(2)} GB`
  return `${(bytes / TB).toFixed(2)} TB`
}
