import type { Project } from '../types'

/** Title-bar order: explicit sort_order, then most-recently-opened. */
export function sortVisibleProjects(projects: Project[]): Project[] {
  return projects
    .filter(project => !project.hidden)
    .slice()
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) || b.last_opened_at - a.last_opened_at
    )
}

/** Map pointer-DnD insert index (0..visible.length) to reorder `toIndex`. */
export function insertIndexToReorderTarget(fromIndex: number, insertIndex: number): number {
  return fromIndex < insertIndex ? insertIndex - 1 : insertIndex
}

/**
 * Live-shift hit testing: lay out chips by snapped widths (excluding the dragged
 * chip), find the insert slot among the others, then return the full id order
 * with `dragId` spliced in. Using frozen widths avoids midpoint oscillation when
 * the DOM already preview-reordered under the pointer.
 */
export function previewReorderIds(
  orderedIds: string[],
  dragId: string,
  widthsById: Map<string, number>,
  gap: number,
  pointerXInContainer: number,
): string[] {
  const dragIndex = orderedIds.indexOf(dragId)
  if (dragIndex < 0) return orderedIds
  const others = orderedIds.filter(id => id !== dragId)
  let x = 0
  let insertAmongOthers = others.length
  for (let i = 0; i < others.length; i++) {
    const w = widthsById.get(others[i]) ?? 0
    if (pointerXInContainer < x + w / 2) {
      insertAmongOthers = i
      break
    }
    x += w + gap
  }
  return [...others.slice(0, insertAmongOthers), dragId, ...others.slice(insertAmongOthers)]
}

/** True when two id sequences are identical. */
export function sameIdOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Left edge of the dragged chip in a frozen-width layout of `previewIds`
 * (container-local X). Used for the accent insert line during live preview.
 */
export function insertLineXForDraggedChip(
  previewIds: string[],
  dragId: string,
  widthsById: Map<string, number>,
  gap: number,
): number | null {
  const index = previewIds.indexOf(dragId)
  if (index < 0) return null
  let x = 0
  for (let i = 0; i < index; i++) {
    x += (widthsById.get(previewIds[i]) ?? 0) + gap
  }
  return Math.max(0, x - 1)
}

/**
 * Reorder the title-bar (non-hidden) projects and assign sequential `sort_order`.
 * Hidden projects keep relative order and receive sort orders after the visible ones.
 * Returns the full next projects array (visible first in new order, then hidden).
 */
export function reorderVisibleProjects(
  projects: Project[],
  fromIndex: number,
  toIndex: number
): Project[] {
  const visible = sortVisibleProjects(projects)
  const hidden = projects.filter(p => p.hidden)
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= visible.length ||
    toIndex >= visible.length ||
    fromIndex === toIndex
  ) {
    return projects
  }
  const nextVisible = [...visible]
  const [moved] = nextVisible.splice(fromIndex, 1)
  nextVisible.splice(toIndex, 0, moved)

  return [
    ...nextVisible.map((project, index) => ({ ...project, sort_order: index })),
    ...hidden.map((project, index) => ({
      ...project,
      sort_order: nextVisible.length + index,
    })),
  ]
}

/** Durable (non-ephemeral) id → sort_order pairs for SQLite persistence. */
export function durableSortOrders(
  projects: Project[]
): Array<{ id: string; sortOrder: number }> {
  return projects
    .filter(project => !project.ephemeral)
    .map(project => ({ id: project.id, sortOrder: project.sort_order ?? 0 }))
}
