import type { EditorState } from '@codemirror/state'
import { resolvePythonImport, resolvePythonImportedNameAnywhere } from './imports/python'
import { resolveJavaScriptImport } from './imports/javascript'
import { resolveGoImport } from './imports/go'
import { resolveRustImport } from './imports/rust'
import { resolveJavaImport } from './imports/java'
import { resolveSameFile } from './sameFile'
import { identifierAt } from './tokenAt'
import { editorStateForFile } from './loadFileState'
import { findSymbolInState } from './sameFile'
import { languageIdForPath, joinPath } from './pathUtils'
import { safeInvoke } from '../tauri'
import { normalizePath } from '../../utils/fileReferences'
import type { DefinitionTarget } from './types'

const JS_LANGS = new Set(['javascript', 'typescript', 'jsx', 'tsx'])

export async function resolveDefinitions(args: {
  state: EditorState
  pos: number
  filePath: string
  languageId: string
  projectRoots: string[]
}): Promise<DefinitionTarget[]> {
  const token = identifierAt(args.state, args.pos)
  if (!token) return []

  const lang = args.languageId || languageIdForPath(args.filePath)
  const ctx = { ...args, languageId: lang, token }

  // 1) Language import resolvers (when cursor is on an import line)
  const fromImport = await resolveImports(ctx)
  if (fromImport.length > 0) return dedupeTargets(fromImport)

  // 1b) Imported name used elsewhere in the file → follow into the module
  if (lang === 'python') {
    const imported = await resolvePythonImportedNameAnywhere(
      args.state,
      token,
      args.filePath,
      args.projectRoots,
    )
    if (imported.length > 0) return dedupeTargets(imported)
  }

  // 2) Same-file symbols / locals / assignment / import bindings
  const same = resolveSameFile(args.state, token.name, args.pos, args.filePath)
  if (same.length > 0) return dedupeTargets(same)

  // 3) Cross-file fallback: search for files that may define the name
  const fallback = await searchWorkspaceSymbol(token.name, lang, args.projectRoots, args.filePath)
  return dedupeTargets(fallback)
}

async function resolveImports(ctx: {
  state: EditorState
  token: { name: string; from: number; to: number }
  filePath: string
  languageId: string
  projectRoots: string[]
}): Promise<DefinitionTarget[]> {
  const { languageId } = ctx
  if (languageId === 'python') {
    return resolvePythonImport(ctx.state, ctx.token, ctx.filePath, ctx.projectRoots)
  }
  if (JS_LANGS.has(languageId)) {
    return resolveJavaScriptImport(ctx.state, ctx.token, ctx.filePath, ctx.projectRoots)
  }
  if (languageId === 'go') {
    return resolveGoImport(ctx.state, ctx.token, ctx.filePath, ctx.projectRoots)
  }
  if (languageId === 'rust') {
    return resolveRustImport(ctx.state, ctx.token, ctx.filePath, ctx.projectRoots)
  }
  if (languageId === 'java') {
    return resolveJavaImport(ctx.state, ctx.token, ctx.filePath, ctx.projectRoots)
  }
  return []
}

async function searchWorkspaceSymbol(
  name: string,
  languageId: string,
  projectRoots: string[],
  currentFile: string,
): Promise<DefinitionTarget[]> {
  if (!name || name.length < 2) return []
  const ext = extensionHint(languageId)
  const out: DefinitionTarget[] = []
  const currentNorm = normalizePath(currentFile).toLowerCase()

  for (const root of projectRoots) {
    try {
      const hits = await safeInvoke<{ path: string }[]>('快速打开文件', 'search_files', {
        root,
        query: ext ? `${name}.${ext}` : name,
        ignoreCase: true,
        fuzzy: true,
        matchSuffix: Boolean(ext),
        extension: ext,
        extensions: null,
        limit: 8,
        excludePatterns: [],
        useIgnoreFiles: true,
        followSymlinks: false,
      })
      for (const hit of hits ?? []) {
        const path = normalizePath(hit.path)
        if (path.toLowerCase() === currentNorm) continue
        const modState = await editorStateForFile(path)
        if (!modState) continue
        const symbols = findSymbolInState(modState, name, path)
        if (symbols.length > 0) {
          out.push(...symbols)
          if (out.length >= 8) return out
        }
      }
    } catch {
      /* ignore missing roots */
    }

    // Also try conventional path name.py / Name.java under root
    if (ext) {
      const guess = joinPath(root, `${name}.${ext}`)
      const modState = await editorStateForFile(guess)
      if (modState) {
        const symbols = findSymbolInState(modState, name, guess)
        out.push(...symbols)
      }
    }
  }
  return out
}

function extensionHint(languageId: string): string | null {
  switch (languageId) {
    case 'python':
      return 'py'
    case 'javascript':
    case 'jsx':
      return 'js'
    case 'typescript':
    case 'tsx':
      return 'ts'
    case 'go':
      return 'go'
    case 'rust':
      return 'rs'
    case 'java':
      return 'java'
    default:
      return null
  }
}

function dedupeTargets(targets: DefinitionTarget[]): DefinitionTarget[] {
  const seen = new Set<string>()
  const out: DefinitionTarget[] = []
  for (const t of targets) {
    const key = `${normalizePath(t.path).toLowerCase()}|${t.line}|${t.from ?? ''}|${t.column ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}
