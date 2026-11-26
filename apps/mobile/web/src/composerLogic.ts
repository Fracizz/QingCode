export type DraftImage = { name: string; mime: string; dataUrl: string }
export const MAX_IMAGES = 4
export const IMAGE_BYTES = 700 * 1024

export function attachmentBytes(images: readonly DraftImage[]): number {
  return images.reduce((total, image) => {
    const base64 = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)
    return total + (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  }, 0)
}

export function isDraftImage(value: unknown): value is DraftImage {
  if (typeof value !== 'object' || value === null) return false
  const image = value as Partial<DraftImage>
  if (typeof image.name !== 'string' || typeof image.mime !== 'string' || typeof image.dataUrl !== 'string' ||
    !/^image\/(?:jpeg|png|gif|webp)$/.test(image.mime)) return false
  const prefix = `data:${image.mime};base64,`
  if (!image.dataUrl.startsWith(prefix)) return false
  const data = image.dataUrl.slice(prefix.length)
  return data.length > 0 && data.length <= Math.ceil(IMAGE_BYTES / 3) * 4 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)
}

export type MentionRange = { start: number; end: number; query: string }

export function mentionAt(text: string, caret: number): MentionRange | null {
  const left = text.slice(0, caret)
  const match = /(?:^|\s)@([^\s`@]*)$/.exec(left)
  if (!match) return null
  const query = match[1] ?? ''
  const tail = /^[^\s`@]*/.exec(text.slice(caret))?.[0] ?? ''
  return { start: caret - query.length - 1, end: caret + tail.length, query }
}

export function insertFileMention(text: string, range: MentionRange, path: string): { text: string; caret: number } {
  const safePath = path.replace(/[\r\n]/g, ' ')
  const delimiter = '`'.repeat(1 + Math.max(0, ...Array.from(safePath.matchAll(/`+/g), (match) => match[0].length)))
  const inserted = `${delimiter}${safePath}${delimiter} `
  return { text: text.slice(0, range.start) + inserted + text.slice(range.end), caret: range.start + inserted.length }
}

export function nearBottom({ scrollHeight, scrollTop, clientHeight }: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return scrollHeight - scrollTop - clientHeight <= 56
}
