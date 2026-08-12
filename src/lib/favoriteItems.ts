import type { FavoriteItem } from '../types'

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathKey(path: string): string {
  const normalized = normalizedPath(path)
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized
}

export function favoriteRelativePath(projectPath: string, absolutePath: string): string | null {
  const root = normalizedPath(projectPath)
  const target = normalizedPath(absolutePath)
  const rootKey = pathKey(root)
  const targetKey = pathKey(target)
  if (targetKey === rootKey) return null
  if (!targetKey.startsWith(`${rootKey}/`)) return null
  return target.slice(root.length + 1)
}

export function favoriteAbsolutePath(projectPath: string, relativePath: string): string {
  const root = projectPath.replace(/[\\/]+$/, '')
  const separator = projectPath.includes('\\') ? '\\' : '/'
  return `${root}${separator}${relativePath.replace(/[\\/]/g, separator)}`
}

function relativeKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

export function favoriteRelativePathKey(projectPath: string, relativePath: string): string {
  const key = relativeKey(relativePath)
  return /^[a-zA-Z]:\//.test(normalizedPath(projectPath)) ? key.toLocaleLowerCase() : key
}

export function reorderFavoriteItems(
  items: FavoriteItem[],
  sourcePath: string,
  targetPath: string,
  position: 'before' | 'after',
): FavoriteItem[] {
  const sourceKey = relativeKey(sourcePath)
  const targetKey = relativeKey(targetPath)
  if (sourceKey === targetKey) return items
  const source = items.find(item => relativeKey(item.relativePath) === sourceKey)
  const target = items.find(item => relativeKey(item.relativePath) === targetKey)
  if (!source || !target || source.projectId !== target.projectId) return items
  const next = items.filter(item => item !== source)
  const targetIndex = next.indexOf(target)
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source)
  const ordered = next.map((item, index) => ({ ...item, sortOrder: index }))
  return ordered.every(
    (item, index) => item.relativePath === items[index]?.relativePath && item.sortOrder === items[index]?.sortOrder,
  )
    ? items
    : ordered
}

export function moveFavoritePath(
  items: FavoriteItem[],
  projectPath: string,
  oldAbsolutePath: string,
  newAbsolutePath: string,
): FavoriteItem[] {
  const oldRelative = favoriteRelativePath(projectPath, oldAbsolutePath)
  const newRelative = favoriteRelativePath(projectPath, newAbsolutePath)
  if (!oldRelative || !newRelative) return items
  const oldKey = favoriteRelativePathKey(projectPath, oldRelative)
  let changed = false
  const next = items.map(item => {
    const itemKey = favoriteRelativePathKey(projectPath, item.relativePath)
    if (itemKey !== oldKey && !itemKey.startsWith(`${oldKey}/`)) return item
    changed = true
    const suffix = item.relativePath.slice(oldRelative.length)
    return { ...item, relativePath: `${newRelative}${suffix}`, available: true }
  })
  if (!changed) return items
  const seen = new Set<string>()
  return next
    .filter(item => {
      const key = favoriteRelativePathKey(projectPath, item.relativePath)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((item, index) => ({ ...item, sortOrder: index }))
}

export function removeFavoritePath(
  items: FavoriteItem[],
  projectPath: string,
  absolutePath: string,
): FavoriteItem[] {
  const relative = favoriteRelativePath(projectPath, absolutePath)
  if (!relative) return items
  const removedKey = favoriteRelativePathKey(projectPath, relative)
  return items
    .filter(item => {
      const key = favoriteRelativePathKey(projectPath, item.relativePath)
      return key !== removedKey && !key.startsWith(`${removedKey}/`)
    })
    .map((item, index) => ({ ...item, sortOrder: index }))
}
