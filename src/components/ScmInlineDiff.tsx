import { useMemo } from 'react'
import DiffEditor from './DiffEditor'
import type { EditorTab } from '../types'
import { guessLanguage } from '../utils/editorHelpers'

type Props = {
  path: string
  name: string
  original: string
  modified: string
}

/** Synthetic DiffEditor host for the full-page SCM workspace (no editor tab). */
export default function ScmInlineDiff({ path, name, original, modified }: Props) {
  const tab = useMemo<EditorTab>(
    () => ({
      id: 'scm-inline-diff',
      path,
      name: `${name} (对比)`,
      dirty: false,
      kind: 'diff',
      content: modified,
      originalContent: original,
      language: guessLanguage(path),
      encoding: 'utf8',
    }),
    [path, name, original, modified],
  )
  return <DiffEditor tab={tab} />
}
