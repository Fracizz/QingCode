import { describe, expect, it } from 'vitest'
import {
  logicalDropPoint,
  sshUploadDropFromQuery,
  type ExplorerDropHit,
} from './sshExplorerDrop'

const project = { kind: 'ssh', path: 'ssh://c1/D:/code/nem-panel' }

describe('logicalDropPoint', () => {
  it('converts physical webview pixels to CSS pixels', () => {
    expect(logicalDropPoint({ x: 200, y: 80 }, 2)).toEqual({ x: 100, y: 40 })
    expect(logicalDropPoint({ x: 15, y: 30 }, 0)).toEqual({ x: 15, y: 30 })
  })
})

describe('sshUploadDropFromQuery', () => {
  it('uploads into the folder under the pointer', () => {
    const hit: ExplorerDropHit = { path: 'ssh://c1/D:/code/nem-panel/src', isDir: true }
    expect(sshUploadDropFromQuery(project, { inUploadZone: true, hit })).toEqual({
      destination: 'ssh://c1/D:/code/nem-panel/src',
      highlight: 'ssh://c1/D:/code/nem-panel/src',
    })
  })

  it('uploads a drop on a file into that file’s parent', () => {
    const hit: ExplorerDropHit = {
      path: 'ssh://c1/D:/code/nem-panel/src/App.tsx',
      isDir: false,
    }
    expect(sshUploadDropFromQuery(project, { inUploadZone: true, hit })).toEqual({
      destination: 'ssh://c1/D:/code/nem-panel/src',
      highlight: hit.path,
    })
  })

  it('uses the project root for empty tree space and the project heading', () => {
    expect(sshUploadDropFromQuery(project, { inUploadZone: true, hit: null })).toEqual({
      destination: project.path,
      highlight: project.path,
    })
    expect(
      sshUploadDropFromQuery(project, {
        inUploadZone: false,
        hit: { path: project.path, isDir: true },
      }),
    ).toEqual({ destination: project.path, highlight: project.path })
  })

  it('ignores local projects and drops outside the explorer', () => {
    expect(
      sshUploadDropFromQuery(
        { kind: 'local', path: 'D:/code/app' },
        { inUploadZone: true, hit: null },
      ),
    ).toBeNull()
    expect(sshUploadDropFromQuery(project, { inUploadZone: false, hit: null })).toBeNull()
    expect(sshUploadDropFromQuery(null, { inUploadZone: true, hit: null })).toBeNull()
  })
})
