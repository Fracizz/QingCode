import type { DefinitionCandidate } from './definitionNavigation'
import { pathsEqual } from '../utils/fileReferences'

export interface UsageGroup {
  key: string
  callerName?: string
  callerKind?: string
  path: string
  relative: string
  approximate: boolean
  candidates: DefinitionCandidate[]
}

export function groupUsageCandidates(
  candidates: DefinitionCandidate[],
  preferPath?: string | null,
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>()

  for (const candidate of candidates) {
    const approximate = Boolean(candidate.approximate)
    const callerName = candidate.callerName?.trim() || undefined
    const callerKind = candidate.callerKind?.trim() || undefined
    const key = [
      approximate ? 'approximate' : 'exact',
      candidate.path.toLowerCase(),
      callerKind?.toLowerCase() ?? 'file',
      callerName?.toLowerCase() ?? '',
    ].join(':')
    const group = groups.get(key)
    if (group) {
      group.candidates.push(candidate)
      continue
    }
    groups.set(key, {
      key,
      callerName,
      callerKind,
      path: candidate.path,
      relative: candidate.relative,
      approximate,
      candidates: [candidate],
    })
  }

  const ordered = [...groups.values()]
  if (!preferPath) return ordered

  // Keep relative order within preferred / other buckets (stable partition).
  const preferred: UsageGroup[] = []
  const other: UsageGroup[] = []
  for (const group of ordered) {
    if (pathsEqual(group.path, preferPath)) preferred.push(group)
    else other.push(group)
  }
  return preferred.length === 0 ? ordered : [...preferred, ...other]
}
