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
