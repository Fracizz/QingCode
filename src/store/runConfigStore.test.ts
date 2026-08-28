import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/tauri')>()
  return {
    ...actual,
    safeInvoke: vi.fn(),
  }
})

import { safeInvoke } from '../lib/tauri'
import { ensureRunConfigDirectory } from './runConfigStore'
import type { Project } from '../types'

const invoke = vi.mocked(safeInvoke)
const remoteProject: Project = {
  id: 'remote',
  name: 'remote',
  path: 'ssh://server/home/owner/app',
  created_at: 1,
  last_opened_at: 1,
  kind: 'ssh',
}

describe('ensureRunConfigDirectory', () => {
  beforeEach(() => invoke.mockReset())

  it('creates a missing .qingcode directory through the SSH command mapping', async () => {
    invoke.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(undefined)

    await ensureRunConfigDirectory(remoteProject)

    expect(invoke).toHaveBeenNthCalledWith(1, '检查运行配置目录', 'validate_directory', {
      path: 'ssh://server/home/owner/app/.qingcode',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, '创建运行配置目录', 'create_directory', {
      parent: remoteProject.path,
      name: '.qingcode',
    })
  })

  it('does nothing for a local project', async () => {
    await ensureRunConfigDirectory({ ...remoteProject, path: 'D:/code/app', kind: 'local' })
    expect(invoke).not.toHaveBeenCalled()
  })
})
