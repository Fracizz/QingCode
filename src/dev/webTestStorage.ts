/** Storage facade keeps real app keys unchanged while isolating each test session. */
export function scopedStorage(storage: Storage, prefix: string): Storage {
  const keys = () =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)!).filter(key =>
      key.startsWith(prefix)
    )
  return {
    get length() {
      return keys().length
    },
    key(index) {
      return keys()[index]?.slice(prefix.length) ?? null
    },
    getItem(key) {
      return storage.getItem(prefix + key)
    },
    setItem(key, value) {
      storage.setItem(prefix + key, value)
    },
    removeItem(key) {
      storage.removeItem(prefix + key)
    },
    clear() {
      keys().forEach(key => storage.removeItem(key))
    },
  }
}

export function testSessionId(search: string): string {
  const id = new URLSearchParams(search).get('testSession') ?? 'manual'
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid testSession')
  return id
}
