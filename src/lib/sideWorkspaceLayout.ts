/** Independent side-dock column flags (dual/quad terminal × editor). */
export type SideWorkspaceColumns = {
  dualTerminal: boolean
  /** 2×2 田 layout; mutually exclusive with dualTerminal. */
  quadTerminal: boolean
  editorVisible: boolean
}

export const SIDE_WORKSPACE_KEY = 'qingcode:side-workspace'
/** Legacy: true meant dual-only (editor hidden). */
export const SIDE_EDITOR_COLLAPSED_KEY = 'qingcode:side-editor-collapsed'

export const DEFAULT_SIDE_WORKSPACE: SideWorkspaceColumns = {
  dualTerminal: true,
  quadTerminal: false,
  editorVisible: false,
}

export const SIDE_WORKSPACE_CHANGED_EVENT = 'qingcode:side-workspace-changed'

function notifySideWorkspaceChanged(columns: SideWorkspaceColumns) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(SIDE_WORKSPACE_CHANGED_EVENT, { detail: { columns } }),
  )
}

function migrateFromLegacyCollapsed(): SideWorkspaceColumns | null {
  try {
    const raw = localStorage.getItem(SIDE_EDITOR_COLLAPSED_KEY)
    if (raw == null) return null
    const collapsed = raw === '1' || raw === 'true'
    // collapsed → dual only; expanded → single terminal + editor
    return collapsed
      ? { dualTerminal: true, quadTerminal: false, editorVisible: false }
      : { dualTerminal: false, quadTerminal: false, editorVisible: true }
  } catch {
    return null
  }
}

/** Enforce dual/quad mutual exclusion (dual wins if both are set). */
export function normalizeSideWorkspaceColumns(
  columns: Partial<SideWorkspaceColumns> & {
    dualTerminal?: boolean
    quadTerminal?: boolean
    editorVisible?: boolean
  },
): SideWorkspaceColumns {
  let dualTerminal = Boolean(columns.dualTerminal)
  let quadTerminal = Boolean(columns.quadTerminal)
  if (dualTerminal && quadTerminal) quadTerminal = false
  return {
    dualTerminal,
    quadTerminal,
    editorVisible: Boolean(columns.editorVisible),
  }
}

export function parseSideWorkspaceColumns(value: unknown): SideWorkspaceColumns {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SIDE_WORKSPACE }
  const record = value as Record<string, unknown>
  return normalizeSideWorkspaceColumns({
    dualTerminal: record.dualTerminal === true,
    quadTerminal: record.quadTerminal === true,
    editorVisible: record.editorVisible === true,
  })
}

export function loadSideWorkspaceColumns(): SideWorkspaceColumns {
  try {
    const raw = localStorage.getItem(SIDE_WORKSPACE_KEY)
    if (raw != null) {
      return parseSideWorkspaceColumns(JSON.parse(raw))
    }
    const migrated = migrateFromLegacyCollapsed()
    if (migrated) {
      saveSideWorkspaceColumns(migrated)
      return migrated
    }
    return { ...DEFAULT_SIDE_WORKSPACE }
  } catch {
    return { ...DEFAULT_SIDE_WORKSPACE }
  }
}

export function saveSideWorkspaceColumns(columns: SideWorkspaceColumns) {
  const next = normalizeSideWorkspaceColumns(columns)
  try {
    localStorage.setItem(SIDE_WORKSPACE_KEY, JSON.stringify(next))
    // Keep legacy key in sync for older builds / tests.
    localStorage.setItem(SIDE_EDITOR_COLLAPSED_KEY, next.editorVisible ? '0' : '1')
  } catch {}
  notifySideWorkspaceChanged(next)
}
