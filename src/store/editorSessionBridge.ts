/**
 * Breaks the static import cycle between projectStore and editorStore.
 * editorStore registers its session APIs at module init; projectStore calls
 * through this bridge so it never imports editorStore.
 */

type EditorSessionApi = {
  activateProjectSession: (previousId: string | null, nextId: string) => void
  renamePath: (from: string, to: string) => void
}

let api: EditorSessionApi | null = null

export function registerEditorSessionApi(next: EditorSessionApi): void {
  api = next
}

export function activateProjectSession(
  previousId: string | null,
  nextId: string,
): void {
  api?.activateProjectSession(previousId, nextId)
}

export function renameEditorPaths(from: string, to: string): void {
  api?.renamePath(from, to)
}
