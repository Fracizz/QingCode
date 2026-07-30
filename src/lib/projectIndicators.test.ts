import { describe, expect, it } from 'vitest'
import type { EditorTab, Project } from '../types'
import {
  countDirtyTabsByProject,
  countRunningTerminalsByProject,
  projectGitRefreshDelay,
  PROJECT_GIT_REFRESH_MAX_MS,
  PROJECT_GIT_REFRESH_MIN_MS,
} from './projectIndicators'

const projects: Project[] = [
  { id: 'a', name: 'A', path: 'D:\\code\\a', created_at: 0, last_opened_at: 0 },
  { id: 'b', name: 'B', path: 'D:\\code\\b', created_at: 0, last_opened_at: 0 },
]

function tab(id: string, path: string, dirty = true): EditorTab {
  return { id, path, name: id, dirty }
}

describe('project indicators', () => {
  it('jitters background Git refreshes between 60 and 90 seconds', () => {
    expect(projectGitRefreshDelay(0)).toBe(PROJECT_GIT_REFRESH_MIN_MS)
    expect(projectGitRefreshDelay(0.5)).toBe(75_000)
    expect(projectGitRefreshDelay(1)).toBe(PROJECT_GIT_REFRESH_MAX_MS)
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
})
