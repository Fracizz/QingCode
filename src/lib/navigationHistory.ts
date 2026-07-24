export type EditorLocation = {
  path: string
  line: number
  /** 1-based column. */
  column: number
}

export type NavigationHistoryState = {
  back: EditorLocation[]
  forward: EditorLocation[]
}

export const EMPTY_NAVIGATION_HISTORY: NavigationHistoryState = {
  back: [],
  forward: [],
}

const MAX_STACK = 50

function normalizeLocationPath(path: string) {
  return path.replace(/\\/g, '/').toLowerCase()
}

export function locationsEqual(a: EditorLocation, b: EditorLocation): boolean {
  return (
    normalizeLocationPath(a.path) === normalizeLocationPath(b.path) &&
    a.line === b.line &&
    a.column === b.column
  )
}

function trimStack(stack: EditorLocation[]): EditorLocation[] {
  if (stack.length <= MAX_STACK) return stack
  return stack.slice(stack.length - MAX_STACK)
}

/**
 * Record the current caret location before an intentional jump.
 * Clears the forward stack (same as browser / VS Code navigation).
 */
export function pushNavigation(
  state: NavigationHistoryState,
  current: EditorLocation | null,
  next?: EditorLocation | null,
): NavigationHistoryState {
  if (!current) return state
  if (next && locationsEqual(current, next)) return state
  const last = state.back[state.back.length - 1]
  if (last && locationsEqual(last, current)) {
    return state.forward.length === 0 ? state : { back: state.back, forward: [] }
  }
  return {
    back: trimStack([...state.back, current]),
    forward: [],
  }
}

export function navigateBack(
  state: NavigationHistoryState,
  current: EditorLocation | null,
): { state: NavigationHistoryState; target: EditorLocation } | null {
  if (state.back.length === 0) return null
  const back = state.back.slice(0, -1)
  const target = state.back[state.back.length - 1]!
  const forward = current ? trimStack([...state.forward, current]) : state.forward
  return { state: { back, forward }, target }
}

export function navigateForward(
  state: NavigationHistoryState,
  current: EditorLocation | null,
): { state: NavigationHistoryState; target: EditorLocation } | null {
  if (state.forward.length === 0) return null
  const forward = state.forward.slice(0, -1)
  const target = state.forward[state.forward.length - 1]!
  const back = current ? trimStack([...state.back, current]) : state.back
  return { state: { back, forward }, target }
}

export function canNavigateBack(state: NavigationHistoryState): boolean {
  return state.back.length > 0
}

export function canNavigateForward(state: NavigationHistoryState): boolean {
  return state.forward.length > 0
}
