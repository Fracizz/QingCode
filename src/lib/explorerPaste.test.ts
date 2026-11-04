import { describe, expect, it } from 'vitest'
import { planExplorerPaste, systemClipboardSignature } from './explorerPaste'

const SSH_DIR = 'ssh://c1/home/owner/app/src'
const LOCAL_DIR = 'D:\\code\\app\\src'

describe('planExplorerPaste', () => {
  it('uploads system clipboard files and folders into an SSH directory', () => {
    expect(
      planExplorerPaste({
        destDir: SSH_DIR,
        clipboard: null,
        systemFiles: ['D:\\tmp\\a.txt', 'D:\\tmp\\folder'],
        systemSignatureAtInternalCopy: null,
      })
    ).toEqual({ kind: 'upload', paths: ['D:\\tmp\\a.txt', 'D:\\tmp\\folder'], fromSystem: true })
  })

  it('prefers a newer system clipboard over an older in-app copy', () => {
    expect(
      planExplorerPaste({
        destDir: SSH_DIR,
        clipboard: { mode: 'copy', paths: ['ssh://c1/home/owner/app/a.txt'] },
        systemFiles: ['D:\\tmp\\b.txt'],
        systemSignatureAtInternalCopy: systemClipboardSignature(['D:\\tmp\\old.txt']),
      })
    ).toMatchObject({ kind: 'upload', paths: ['D:\\tmp\\b.txt'] })
  })

  it('keeps the in-app copy when the system clipboard has not changed since', () => {
    const clipboard = { mode: 'copy' as const, paths: ['ssh://c1/home/owner/app/a.txt'] }
    expect(
      planExplorerPaste({
        destDir: SSH_DIR,
        clipboard,
        systemFiles: ['D:\\tmp\\old.txt'],
        systemSignatureAtInternalCopy: systemClipboardSignature(['D:\\tmp\\old.txt']),
      })
    ).toEqual({ kind: 'internal', clipboard })
  })

  it('uploads in-app copied local paths into an SSH directory', () => {
    expect(
      planExplorerPaste({
        destDir: SSH_DIR,
        clipboard: { mode: 'cut', paths: ['D:\\code\\other\\dir'] },
        systemFiles: [],
        systemSignatureAtInternalCopy: '',
      })
    ).toEqual({ kind: 'upload', paths: ['D:\\code\\other\\dir'], fromSystem: false })
  })

  it('ignores the system clipboard for local destinations', () => {
    expect(
      planExplorerPaste({
        destDir: LOCAL_DIR,
        clipboard: null,
        systemFiles: ['D:\\tmp\\a.txt'],
        systemSignatureAtInternalCopy: null,
      })
    ).toEqual({ kind: 'none' })
  })
})
