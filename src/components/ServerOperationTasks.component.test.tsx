// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import ServerOperationTasks from './ServerOperationTasks'
import SshPreparationIcon from './SshPreparationIcon'
import {
  beginServerOperation,
  finishServerOperation,
  reportServerOperation,
  useServerOperationStore,
} from '../store/serverOperationStore'

const root = 'ssh://c/home/demo'
const iconLabel = '正在后台更新远端服务，点击查看进度'
const hide = () => fireEvent.click(screen.getByRole('button', { name: '后台运行' }))

beforeEach(() => {
  vi.useFakeTimers()
  useServerOperationStore.setState({ tasks: {} })
  beginServerOperation(root, 'demo', 'update')
})
afterEach(() => vi.useRealTimers())

describe('ServerOperationTasks background mode', () => {
  it('hides a running update without dropping later progress', () => {
    render(<ServerOperationTasks />)
    hide()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    act(() => reportServerOperation(root, 3, '正在通过 SSH 上传并校验服务包…'))
    expect(useServerOperationStore.getState().tasks[root]).toMatchObject({ step: 3, background: true })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows the card again with its actions when a hidden update fails', () => {
    render(<ServerOperationTasks />)
    hide()
    act(() => finishServerOperation(root, 'boom'))
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    expect(screen.getByRole('button', { name: '更新远端服务' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '后台运行' })).not.toBeInTheDocument()
  })

  it('stays hidden on success and removes the finished task', () => {
    render(<ServerOperationTasks />)
    hide()
    act(() => finishServerOperation(root))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(2500) })
    expect(useServerOperationStore.getState().tasks[root]).toBeUndefined()
  })

  it('offers no background action once the task has finished', () => {
    render(<ServerOperationTasks />)
    act(() => finishServerOperation(root))
    expect(screen.queryByRole('button', { name: '后台运行' })).not.toBeInTheDocument()
  })

  it('re-expands from the project icon without triggering the surrounding project switch', () => {
    const onSwitch = vi.fn()
    render(<>
      <ServerOperationTasks />
      <div onClick={onSwitch}><SshPreparationIcon path={root} size={12} /></div>
    </>)
    expect(screen.queryByRole('button', { name: iconLabel })).not.toBeInTheDocument()
    hide()
    fireEvent.click(screen.getByRole('button', { name: iconLabel }))
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: iconLabel })).not.toBeInTheDocument()
    expect(onSwitch).not.toHaveBeenCalled()
  })
})
