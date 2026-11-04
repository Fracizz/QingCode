// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLaunchFileRequests } from './useLaunchFileRequests'

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  openLaunchFiles: vi.fn(),
  unlistenOpen: vi.fn(),
  unlistenCli: vi.fn(),
  listenForOpenFileRequests: vi.fn(),
  listenForCliRequests: vi.fn(),
  safeInvoke: vi.fn(),
  isExternalFileWindow: vi.fn(() => false),
}))

vi.mock('../lib/tauri', () => ({
  isTauri: mocks.isTauri,
  safeInvoke: mocks.safeInvoke,
}))
vi.mock('../lib/windowSession', () => ({
  isExternalFileWindow: mocks.isExternalFileWindow,
}))
vi.mock('../lib/launchFiles', () => ({
  openLaunchFiles: mocks.openLaunchFiles,
  listenForOpenFileRequests: mocks.listenForOpenFileRequests,
}))
vi.mock('../lib/cliBridge', () => ({
  listenForCliRequests: mocks.listenForCliRequests,
}))

function Harness({
  projectsReady,
  hasProject = false,
  openPathsKey = '',
}: {
  projectsReady: boolean
  hasProject?: boolean
  openPathsKey?: string
}) {
  useLaunchFileRequests(projectsReady, hasProject, openPathsKey)
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isTauri.mockReturnValue(true)
  mocks.openLaunchFiles.mockResolvedValue(undefined)
  mocks.listenForOpenFileRequests.mockResolvedValue(mocks.unlistenOpen)
  mocks.listenForCliRequests.mockResolvedValue(mocks.unlistenCli)
  mocks.safeInvoke.mockResolvedValue(undefined)
  mocks.isExternalFileWindow.mockReturnValue(false)
})

describe('useLaunchFileRequests', () => {
  it('waits for project restoration before consuming startup file arguments', async () => {
    const view = render(<Harness projectsReady={false} />)

    await waitFor(() => {
      expect(mocks.listenForOpenFileRequests).toHaveBeenCalledOnce()
      expect(mocks.listenForCliRequests).toHaveBeenCalledOnce()
    })
    expect(mocks.openLaunchFiles).not.toHaveBeenCalled()

    view.rerender(<Harness projectsReady />)

    await waitFor(() => expect(mocks.openLaunchFiles).toHaveBeenCalledOnce())
  })

  it('cleans up listeners registered before project restoration completes', async () => {
    const view = render(<Harness projectsReady={false} />)
    await waitFor(() => expect(mocks.listenForOpenFileRequests).toHaveBeenCalledOnce())

    view.unmount()

    expect(mocks.unlistenOpen).toHaveBeenCalledOnce()
    expect(mocks.unlistenCli).toHaveBeenCalledOnce()
  })

  it('releases the external-file receiver role after opening a project', async () => {
    mocks.isExternalFileWindow.mockReturnValue(true)

    render(<Harness projectsReady hasProject />)

    await waitFor(() => {
      expect(mocks.safeInvoke).toHaveBeenCalledWith(
        '切换独立文件窗口角色',
        'release_external_file_window',
      )
    })
  })

  it('registers open paths for cross-window duplicate activation', async () => {
    render(
      <Harness
        projectsReady
        openPathsKey={'D:\\docs\\a.md\0D:\\docs\\b.ts'}
      />,
    )

    await waitFor(() => {
      expect(mocks.safeInvoke).toHaveBeenCalledWith(
        '同步窗口打开文件',
        'sync_open_file_paths',
        { paths: ['D:\\docs\\a.md', 'D:\\docs\\b.ts'] },
      )
    })
  })
})
