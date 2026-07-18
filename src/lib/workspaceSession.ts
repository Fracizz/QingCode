import type { Project } from '../types'

/** Prefer a durable visible project; fall back to any available (including ephemeral). */
export function pickAvailableProject(
  projects: Project[],
  unavailableProjectIds: string[],
): Project | undefined {
  return (
    projects.find(
      project =>
        !project.hidden &&
        !unavailableProjectIds.includes(project.id) &&
        !project.ephemeral,
    ) ??
    projects.find(
      project => !project.hidden && !unavailableProjectIds.includes(project.id),
    )
  )
}

/** First non-hidden candidate for immediate open before path validation finishes. */
export function pickRestoreCandidate(
  projects: Project[],
  ephemeralProjects: Project[],
): Project | undefined {
  return (
    projects.find(project => !project.hidden) ??
    ephemeralProjects.find(project => !project.hidden)
  )
}

export function mergeProjectsWithEphemeral(
  persisted: Project[],
  ephemeral: Project[],
): Project[] {
  return [...ephemeral, ...persisted]
}

export function buildExpandedProjectsMap(
  projects: Project[],
  previous: Record<string, boolean>,
): Record<string, boolean> {
  const expandedProjects: Record<string, boolean> = {}
  for (const p of projects) {
    expandedProjects[p.id] = previous[p.id] ?? true
  }
  return expandedProjects
}

export function nextEmptyProjectName(existingNames: Iterable<string>): string {
  const names = new Set(existingNames)
  let index = 1
  let name = '临时项目'
  while (names.has(name)) {
    index += 1
    name = `临时项目 ${index}`
  }
  return name
}

export function createEphemeralProject(input: {
  id: string
  name: string
  path: string
  now?: number
}): Project {
  const now = input.now ?? Date.now()
  return {
    id: input.id,
    name: input.name,
    path: input.path,
    created_at: now,
    last_opened_at: now,
    ephemeral: true,
  }
}
