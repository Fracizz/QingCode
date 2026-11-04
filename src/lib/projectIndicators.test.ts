/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import type { EditorTab, Project } from '../types'
import {
  countDirtyTabsByProject,
  countRunningTerminalsByProject,
  GIT_DIRTY_COUNT_EVENT,
  gitDirtyCountForProject,
  notifyGitDirtyCount,
  projectGitRefreshDelay,
  projectPathsMatch,
  SSH_PROJECT_GIT_REFRESH_MULTIPLIER,
} from './projectIndicators'

const projects: Project[] = [
  { id: 'a', name: 'A', path: 'D:\\code\\a', created_at: 0, last_opened_at: 0 },
  { id: 'b', name: 'B', path: 'D:\\code\\b', created_at: 0, last_opened_at: 0 },
]

function tab(id: string, path: string, dirty = true): EditorTab {
  return { id, path, name: id, dirty }
}

describe('project indicators', () => {
  it('does not attribute a stale store count to another project', () => {
    expect(gitDirtyCountForProject('D:\\code\\a', 'D:/code/a', 7)).toBe(7)
    expect(gitDirtyCountForProject('D:\\code\\b', 'D:/code/a', 11)).toBe(0)
    expect(gitDirtyCountForProject('ssh://c1/D:/code/app', 'ssh://c1/D:/code/app', 3)).toBe(3)
    expect(gitDirtyCountForProject('ssh://c1/D:/code/app', 'ssh://c1/D:/code/other', 9)).toBe(0)
    expect(gitDirtyCountForProject(null, 'D:/code/a', 4)).toBe(0)
    expect(gitDirtyCountForProject('D:/code/a', null, 4)).toBe(0)
  })

  it('randomizes background Git refreshes in whole minutes from a 5-minute floor', () => {
    expect(projectGitRefreshDelay(5, 0)).toBe(300_000)
    expect(projectGitRefreshDelay(5, 0.5)).toBe(420_000)
    expect(projectGitRefreshDelay(5, 1)).toBe(480_000)
    expect(projectGitRefreshDelay(4, 0)).toBe(300_000)
  })

  it('backs off SSH project polling so a 5-minute floor does not mean 5-minute RTTs', () => {
    expect(projectGitRefreshDelay(5, 0, true)).toBe(300_000 * SSH_PROJECT_GIT_REFRESH_MULTIPLIER)
    expect(projectGitRefreshDelay(5, 1, true)).toBe(480_000 * SSH_PROJECT_GIT_REFRESH_MULTIPLIER)
    expect(projectGitRefreshDelay(5, 0, false)).toBe(300_000)
  })

  it('groups dirty active and inactive tabs by owning project without duplicates', () => {
    expect(
      countDirtyTabsByProject(
        projects,
        [tab('a1', 'D:\\code\\a\\src\\a.ts'), tab('clean', 'D:\\code\\b\\clean.ts', false)],
        {
          b: {
            tabs: [tab('b1', 'D:\\code\\b\\src\\b.ts'), tab('a1', 'D:\\code\\a\\src\\a.ts')],
          },
        }
      )
    ).toEqual({ a: 1, b: 1 })
  })

  it('counts only live terminals', () => {
    expect(
      countRunningTerminalsByProject([
        { projectId: 'a', status: 'running' },
        { projectId: 'a', status: 'starting' },
        { projectId: 'a', status: 'exited' },
        { projectId: 'b', status: 'running' },
      ])
    ).toEqual({ a: 2, b: 1 })
  })

  it('matches project paths across separators and drive-letter case', () => {
    expect(projectPathsMatch('D:\\code\\a', 'd:/code/a')).toBe(true)
    expect(projectPathsMatch('D:\\code\\a', 'D:\\code\\b')).toBe(false)
  })

  it('notifies listeners when the Git dirty count changes', () => {
    const seen: Array<{ projectPath: string; dirtyCount: number }> = []
    const onCount = (event: Event) => {
      seen.push((event as CustomEvent<{ projectPath: string; dirtyCount: number }>).detail)
    }
    window.addEventListener(GIT_DIRTY_COUNT_EVENT, onCount)
    notifyGitDirtyCount('D:\\code\\a', 3)
    window.removeEventListener(GIT_DIRTY_COUNT_EVENT, onCount)
    expect(seen).toEqual([{ projectPath: 'D:\\code\\a', dirtyCount: 3 }])
  })
})
