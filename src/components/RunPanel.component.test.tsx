// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import ConfirmDialog from './ConfirmDialog'
import RunConfigEditor from './RunConfigEditor'
import RunPanel from './RunPanel'
import { useConfirmStore } from '../store/confirmStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useRunConfigStore, type RunConfig } from '../store/runConfigStore'
import { useTerminalStore } from '../store/terminalStore'

const project: Project = {
  id: 'project-1',
  name: '示例项目',
  path: 'D:/example',
  created_at: 1,
  last_opened_at: 1,
  ephemeral: true,
}

const config: RunConfig = {
  id: 'dev',
  name: '开发服务',
  tasks: [{ id: 'frontend', type: 'command', target: 'pnpm dev' }],
}

const initialProjectState = useProjectStore.getState()
const initialRunConfigState = useRunConfigStore.getState()
const initialTerminalState = useTerminalStore.getState()

describe('RunPanel', () => {
  beforeEach(() => {
    useProjectStore.setState({ currentProject: project, projects: [project], toasts: [] })
    useTerminalStore.setState({ terminals: [], activeTerminalId: null })
    useConfirmStore.getState().answer(false)
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useRunConfigStore.setState(initialRunConfigState, true)
    useTerminalStore.setState(initialTerminalState, true)
    useConfirmStore.getState().answer(false)
  })

  it('runs, stops, and confirms deletion of a configuration', async () => {
    const loadConfigs = vi.fn().mockResolvedValue([config])
    const runConfig = vi.fn().mockResolvedValue(undefined)
    const stopConfig = vi.fn().mockResolvedValue(undefined)
    const removeConfig = vi.fn().mockResolvedValue(undefined)
    useRunConfigStore.setState({
      configsByProject: { [project.id]: [config] },
      loadConfigs,
      runConfig,
      stopConfig,
      removeConfig,
    })

    render(
      <>
        <RunPanel />
        <ConfirmDialog />
      </>,
    )

    await waitFor(() => expect(loadConfigs).toHaveBeenCalledWith(project))
    fireEvent.click(screen.getByRole('button', { name: '运行「开发服务」' }))
    expect(runConfig).toHaveBeenCalledWith(project, config)

    useTerminalStore.setState({
      terminals: [
        {
          id: 'terminal-1',
          name: '开发服务',
          projectId: project.id,
          cwd: project.path,
          launchCommand: 'pnpm dev',
          status: 'running',
          exitCode: null,
          runConfigId: config.id,
        },
      ],
    })
    fireEvent.click(await screen.findByRole('button', { name: '停止「开发服务」' }))
    expect(stopConfig).toHaveBeenCalledWith(config)

    fireEvent.click(screen.getByRole('button', { name: '删除运行配置「开发服务」' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveAttribute('aria-labelledby', 'confirm-title')
    expect(dialog).toHaveAttribute('aria-describedby', 'confirm-message')
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }))
    await waitFor(() => expect(removeConfig).toHaveBeenCalledWith(project, config.id))
  })

  it('creates a configuration from the keyboard-accessible editor', async () => {
    const upsertConfig = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    useRunConfigStore.setState({ upsertConfig })

    render(<RunConfigEditor project={project} initial={null} onClose={onClose} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-labelledby')
    expect(dialog).toHaveAttribute('aria-describedby')
    const name = screen.getByLabelText('名称')
    expect(name).toHaveFocus()
    fireEvent.change(name, { target: { value: '本地开发' } })
    fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'pnpm dev' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(upsertConfig).toHaveBeenCalledWith(
        project,
        expect.objectContaining({
          name: '本地开发',
          tasks: [expect.objectContaining({ type: 'command', target: 'pnpm dev' })],
        }),
      ),
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('opens run.json from the relative path hint', async () => {
    const openFile = vi.fn().mockResolvedValue(undefined)
    useRunConfigStore.setState({
      configsByProject: { [project.id]: [config] },
      loadConfigs: vi.fn().mockResolvedValue([config]),
      runConfig: vi.fn(),
      stopConfig: vi.fn(),
      removeConfig: vi.fn(),
    })
    const previous = useEditorStore.getState().openFile
    useEditorStore.setState({ openFile })

    try {
      render(<RunPanel />)
      fireEvent.click(screen.getByRole('button', { name: '打开文件: .qingcode/run.json' }))
      expect(openFile).toHaveBeenCalledWith('D:/example/.qingcode/run.json')
    } finally {
      useEditorStore.setState({ openFile: previous })
    }
  })
})
