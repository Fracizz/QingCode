import type { DefinitionCandidate } from './definitionNavigation'

export interface UsageGroup {
  key: string
  callerName?: string
  callerKind?: string
  relative: string
  approximate: boolean
  candidates: DefinitionCandidate[]
}

export function groupUsageCandidates(candidates: DefinitionCandidate[]): UsageGroup[] {
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
      relative: candidate.relative,
      approximate,
      candidates: [candidate],
    })
  }

  return [...groups.values()]
}
