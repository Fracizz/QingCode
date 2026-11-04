import { describe, expect, it } from 'vitest'
import type { TransferRequest } from '../store/transferStore'
import { formatTransferLocation, transferTaskDetail } from './transferLabel'

const request: TransferRequest = {
  direction: 'upload',
  paths: ['D:\\docs\\note.txt'],
  destination: 'ssh://23a6efe9-51bb-4121-9d8c-41538a81d6b2/D:/code/app/.qingcode/terminal-paste/stamp',
}

describe('formatTransferLocation', () => {
  it('strips the SSH connection id', () => {
    expect(formatTransferLocation(request.destination)).toBe(
      '/D:/code/app/.qingcode/terminal-paste/stamp',
    )
  })

  it('leaves local paths unchanged', () => {
    expect(formatTransferLocation('D:\\docs\\note.txt')).toBe('D:\\docs\\note.txt')
  })
})

describe('transferTaskDetail', () => {
  it('shows the file being transferred', () => {
    expect(
      transferTaskDetail({ status: 'running', currentPath: 'D:\\docs\\note.txt', request }),
    ).toBe('note.txt')
  })

  it('shows source names after completion instead of the remote paste directory', () => {
    expect(transferTaskDetail({ status: 'completed', currentPath: null, request })).toBe('note.txt')
  })
})
