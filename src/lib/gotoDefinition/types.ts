export type DefinitionTarget = {
  path: string
  line: number
  column?: number
  from?: number
  /** Short label for multi-candidate UI (e.g. symbol kind or relative path). */
  label?: string
}

export type IdentifierToken = {
  name: string
  from: number
  to: number
}

export type ResolveContext = {
  state: import('@codemirror/state').EditorState
  pos: number
  filePath: string
  languageId: string
  projectRoots: string[]
  token: IdentifierToken
}
