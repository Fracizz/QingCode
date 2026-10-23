import { describe, expect, it } from 'vitest'
import { visibleTransferTasks, type TransferTask } from './transferStore'

function task(id: string, ephemeral: boolean, status: TransferTask['status']): TransferTask {
  return {
    taskId: id,
    status,
    completedFiles: 0,
    completedBytes: 0,
    completedPaths: [],
    request: { direction: 'upload', paths: ['a'], destination: 'ssh://c/dest', ephemeral },
  }
}

describe('visibleTransferTasks', () => {
  it('hides an in-progress ephemeral upload so the workspace does not resize', () => {
    const visible = visibleTransferTasks([
      task('paste', true, 'running'),
      task('explorer', false, 'running'),
      task('failed-paste', true, 'failed'),
    ])
    expect(visible.map(item => item.taskId)).toEqual(['explorer', 'failed-paste'])
  })
})
