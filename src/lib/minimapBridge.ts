import type { ViewUpdate } from '@codemirror/view'

type MinimapUpdateHandler = (update: ViewUpdate) => void

let handler: MinimapUpdateHandler | null = null

/** Register the active minimap's CM update handler (at most one). */
export function setMinimapUpdateHandler(next: MinimapUpdateHandler | null) {
  handler = next
}

/** Called from the shared EditorView updateListener. */
export function emitMinimapUpdate(update: ViewUpdate) {
  handler?.(update)
}
