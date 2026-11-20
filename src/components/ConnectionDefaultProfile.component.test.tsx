// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { connectionDefaultProfileId, effectiveDefaultProfileIdFor } from '../lib/terminal/connectionDefaultProfile'
import { saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import ConnectionDefaultProfile from './ConnectionDefaultProfile'

const claude: TerminalProfile = { id: 'claude', name: 'claude', shell: 'bash', command: 'claude' }
const codex: TerminalProfile = { id: 'codex', name: 'codex', shell: 'bash', command: 'codex' }
const settings = { profiles: [claude, codex], defaultProfileId: 'claude', defaultShell: 'bash' as const }

beforeEach(() => {
  localStorage.clear()
  saveTerminalProfileSettings(settings)
})

it('overrides the global default per connection and falls back when unset', () => {
  const view = render(<ConnectionDefaultProfile connectionId="a" />)
  expect(screen.getByRole('button', { name: '默认终端配置' })).toHaveTextContent('跟随全局默认（claude）')
  fireEvent.click(screen.getByRole('button', { name: '默认终端配置' }))
  fireEvent.click(screen.getByRole('option', { name: 'codex' }))
  expect(effectiveDefaultProfileIdFor('a')).toBe('codex')
  expect(effectiveDefaultProfileIdFor('b')).toBe('claude')
  expect(effectiveDefaultProfileIdFor(null)).toBe('claude')

  view.rerender(<ConnectionDefaultProfile connectionId="b" />)
  expect(screen.getByRole('button', { name: '默认终端配置' })).toHaveTextContent('跟随全局默认（claude）')
})

it('drops a connection default whose profile was deleted', () => {
  localStorage.setItem('qingcode:connection-default-profile:a', 'codex')
  expect(connectionDefaultProfileId('a')).toBe('codex')
  saveTerminalProfileSettings({ ...settings, profiles: [claude] })
  expect(connectionDefaultProfileId('a')).toBeNull()
  expect(effectiveDefaultProfileIdFor('a')).toBe('claude')
})
