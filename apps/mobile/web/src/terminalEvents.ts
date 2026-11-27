export type MobileTerminalEvent = {
  targetId: string
  projectId: string
  name: 'term.data' | 'term.exit' | 'term.resized' | 'term.error'
  payload: unknown
}

type TerminalListener = (event: MobileTerminalEvent) => void
const listeners = new Map<string, Set<TerminalListener>>()

export function subscribeTerminalEvents(desktopId: string, listener: TerminalListener): () => void {
  const group = listeners.get(desktopId) ?? new Set<TerminalListener>()
  group.add(listener)
  listeners.set(desktopId, group)
  return () => {
    group.delete(listener)
    if (group.size === 0 && listeners.get(desktopId) === group) listeners.delete(desktopId)
  }
}

export function deliverTerminalEvent(desktopId: string, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const event = raw as Partial<MobileTerminalEvent>
  if (typeof event.targetId !== 'string' || typeof event.projectId !== 'string' ||
    (event.name !== 'term.data' && event.name !== 'term.exit' && event.name !== 'term.resized' && event.name !== 'term.error')) return
  for (const listener of listeners.get(desktopId) ?? []) listener(event as MobileTerminalEvent)
}
