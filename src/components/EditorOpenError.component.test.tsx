// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTab, Project } from '../types'
import EditorOpenError from './EditorOpenError'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
  openDialog: vi.fn(),
  authorizePaths: vi.fn(),
  startSshTransfer: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: mocks.openPath,
  revealItemInDir: mocks.revealItemInDir,
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.openDialog }))
vi.mock('../lib/pathAllowlist', () => ({ authorizePaths: mocks.authorizePaths }))
vi.mock('../lib/sshTransfer', () => ({ startSshTransfer: mocks.startSshTransfer }))

const remoteProject = {
  id: 'p1',
  name: 'nem-panel',
  path: 'ssh://c1/D:/code/nem-panel',
  kind: 'ssh',
  created_at: 1,
  last_opened_at: 1,
} as Project

const remotePngPath =
  'ssh://c1/D:/code/nem-panel/.qingcode/terminal-paste/mkfegzf/paste-e641.png'

function tab(overrides: Partial<EditorTab>): EditorTab {
  return {
    id: 't1',
    path: remotePngPath,
    name: 'paste-e641.png',
    dirty: false,
    loading: false,
    ...overrides,
  }
}

const initialProjectState = useProjectStore.getState()
const initialUIState = useUIStore.getState()

describe('EditorOpenError', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [remoteProject], currentProject: remoteProject })
    mocks.openPath.mockReset().mockResolvedValue(undefined)
    mocks.revealItemInDir.mockReset().mockResolvedValue(undefined)
    mocks.openDialog.mockReset()
    mocks.authorizePaths.mockReset().mockResolvedValue(undefined)
    mocks.startSshTransfer.mockReset()
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useUIStore.setState(initialUIState, true)
  })

  it('explains a remote binary file by type instead of repeating decoder jargon', () => {
    render(
      <EditorOpenError
        tab={tab({ openError: '远程文件包含二进制内容，不是文本文件', openErrorKind: 'binary' })}
      />,
    )

    expect(screen.getByText('无法在编辑器中以文本方式打开此文件。')).toBeInTheDocument()
    expect(screen.getByText('此文件是图片（.png），不是文本文件。')).toBeInTheDocument()
    expect(screen.getByText('需要查看内容时，可下载到本地后用对应应用打开。')).toBeInTheDocument()
    // `ssh://<connection-id>` is noise in the pane; the project-relative path wins.
    expect(screen.getByText('.qingcode/terminal-paste/mkfegzf/paste-e641.png')).toBeInTheDocument()
    expect(screen.queryByText(/binary content/)).not.toBeInTheDocument()
  })

  it('offers download-open for remote files and hides actions that cannot work', () => {
    render(
      <EditorOpenError
        tab={tab({ openError: '远程文件包含二进制内容，不是文本文件', openErrorKind: 'binary' })}
      />,
    )

    expect(screen.getByRole('button', { name: /下载到本地并打开/ })).toBeInTheDocument()
    // No local handler for an ssh:// path, and retrying a binary read always fails.
    expect(screen.queryByRole('button', { name: /在关联的应用程序中打开/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^重试$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /在文件管理器中显示/ })).not.toBeInTheDocument()
  })

  it('keeps the associated-app action and retry for local failures', async () => {
    mocks.openPath.mockResolvedValue(undefined)
    render(
      <EditorOpenError
        tab={tab({ path: 'D:/code/app/shot.png', openError: '无法识别文件编码', openErrorKind: 'encoding' })}
      />,
    )

    expect(screen.getByRole('button', { name: /在关联的应用程序中打开/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^重试$/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /下载到本地并打开/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /在关联的应用程序中打开/ }))
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('D:/code/app/shot.png'))
  })

  it('downloads a remote file to the chosen folder and opens the local copy', async () => {
    mocks.openDialog.mockResolvedValue('C:\\Users\\me\\Downloads')
    mocks.startSshTransfer.mockResolvedValue({ status: 'completed', completedPaths: [remotePngPath] })

    render(
      <EditorOpenError
        tab={tab({ openError: '远程文件包含二进制内容，不是文本文件', openErrorKind: 'binary' })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /下载到本地并打开/ }))

    await waitFor(() =>
      expect(mocks.startSshTransfer).toHaveBeenCalledWith({
        direction: 'download',
        paths: [remotePngPath],
        destination: 'C:\\Users\\me\\Downloads',
        ephemeral: true,
      }),
    )
    await waitFor(() =>
      expect(mocks.openPath).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\paste-e641.png'),
    )
  })

  it('keeps the read-only preview escape hatch for remote decode failures', () => {
    render(
      <EditorOpenError
        tab={tab({
          path: 'ssh://c1/D:/code/nem-panel/scripts/install.sh',
          name: 'install.sh',
          openError: '无法识别文件编码（二进制内容）：install.sh',
          openErrorKind: 'encoding',
        })}
      />,
    )

    expect(screen.getByText('文件内容无法按当前编码解码。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /仍然打开（只读预览）/ })).toBeInTheDocument()
  })
})
