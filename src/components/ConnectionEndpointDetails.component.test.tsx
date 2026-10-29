// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import ConnectionEndpointDetails from './ConnectionEndpointDetails'
import { directAgentApi } from '../lib/directAgent'
import { useProjectStore } from '../store/projectStore'

vi.mock('../lib/directAgent', () => ({ directAgentApi: { info: vi.fn() } }))

beforeEach(() => {
  vi.mocked(directAgentApi.info).mockReset()
  useProjectStore.setState({ sshConnections: [{ id: 'win', name: 'WinDev', host: 'ssh.example', port: 28822, username: 'Administrator', auth_kind: 'password', host_key_fingerprint: 'ssh-key', created_at: 1, updated_at: 1 }] })
})

it('shows the actual Agent endpoint rather than the SSH host or port', async () => {
  vi.mocked(directAgentApi.info).mockResolvedValue({ enabled: true, host: '192.168.252.107', port: 48763, certificateFingerprint: 'pin', tokenSaved: true, previousPorts: [] })
  render(<dl><ConnectionEndpointDetails connectionId="win" agent /></dl>)
  expect(await screen.findByText('48763')).toBeVisible()
  expect(screen.getByText('192.168.252.107')).toBeVisible()
  expect(screen.queryByText('28822')).toBeNull()
  expect(screen.queryByText('ssh.example')).toBeNull()
})

it('shows the configured SSH endpoint for SSH transport', () => {
  render(<dl><ConnectionEndpointDetails connectionId="win" agent={false} /></dl>)
  expect(screen.getByText('28822')).toBeVisible()
  expect(screen.getByText('ssh.example')).toBeVisible()
  expect(directAgentApi.info).not.toHaveBeenCalled()
})

it('does not invent a default port or fall back to SSH when Agent metadata is missing', async () => {
  vi.mocked(directAgentApi.info).mockResolvedValue(null)
  render(<dl><ConnectionEndpointDetails connectionId="win" agent /></dl>)
  expect(await screen.findAllByText('未知')).toHaveLength(2)
  expect(screen.queryByText('28822')).toBeNull()
  expect(screen.queryByText('48763')).toBeNull()
})
