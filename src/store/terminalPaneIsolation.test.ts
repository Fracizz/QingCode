import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../types'
import {
  inferTerminalPaneOwnership,
  reorderTerminalTabs,
  terminalPaneOf,
  useTerminalStore,
} from './terminalStore'

vi.mock('../lib/tauri', () => ({
  safeInvoke: vi.fn(async () => undefined),
}))

vi.mock('./projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: { id: 'p1', path: 'D:/proj', name: 'proj', ephemeral: false },
      projects: [{ id: 'p1', path: 'D:/proj', name: 'proj', ephemeral: false }],
      pushToast: vi.fn(),
    }),
  },
}))

vi.mock('./uiStore', () => ({
  useUIStore: {
    getState: () => ({
      openTerminalPanel: vi.fn(),
    }),
  },
}))

vi.mock('@/lib/terminal/terminalProfiles', () => ({
  DEFAULT_TERMINAL_PROFILE: {
    id: 'default',
    name: 'PowerShell',
    shell: 'powershell',
    command: '',
  },
  getTerminalProfile: () => ({
    id: 'default',
    name: 'PowerShell',
    shell: 'powershell',
    command: '',
  }),
  loadTerminalProfileSettings: () => ({
    defaultProfileId: 'default',
    defaultShell: 'powershell',
    profiles: [],
  }),
}))

vi.mock('@/lib/terminal/terminalProfileTrust', () => ({
  ensureTerminalProfileTrust: vi.fn(async () => true),
}))

vi.mock('../lib/workspaceTrust', () => ({
  isProjectTrusted: () => true,
}))

function tab(
  id: string,
  pane?: TerminalTab['pane'],
  extras: Partial<TerminalTab> = {},
): TerminalTab {
  return {
    id,
    name: id,
    projectId: 'p1',
    cwd: 'D:/proj',
    launchCommand: '',
    pane,
    status: 'running',
    exitCode: null,
    ...extras,
  }
}

describe('terminal pane isolation', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      activeTerminalByProject: {},
      secondaryTerminalId: null,
      secondaryTerminalByProject: {},
      blTerminalId: null,
      blTerminalByProject: {},
      brTerminalId: null,
      brTerminalByProject: {},
      terminalFocusPane: 'primary',
    })
  })

  it('inferTerminalPaneOwnership assigns legacy bindings to panes', () => {
    const terminals = [tab('a'), tab('b'), tab('c'), tab('d')]
    const owned = inferTerminalPaneOwnership(terminals, {
      activeTerminalByProject: { p1: 'a' },
      secondaryTerminalByProject: { p1: 'b' },
      blTerminalByProject: { p1: 'c' },
      brTerminalByProject: { p1: 'd' },
    })
    expect(owned.map(t => [t.id, terminalPaneOf(t)])).toEqual([
      ['a', 'primary'],
      ['b', 'secondary'],
      ['c', 'bl'],
      ['d', 'br'],
    ])
  })

  it('reorders terminal tabs around a drop target without disturbing other tabs', () => {
    const terminals = [
      tab('p1a', 'primary'),
      tab('tr1', 'secondary'),
      tab('p1b', 'primary'),
      tab('tr2', 'secondary'),
    ]

    expect(reorderTerminalTabs(terminals, 'p1b', 'p1a', 'before').map(t => t.id)).toEqual([
      'p1b',
      'p1a',
      'tr1',
      'tr2',
    ])
    expect(reorderTerminalTabs(terminals, 'tr1', 'tr2', 'after').map(t => t.id)).toEqual([
      'p1a',
      'p1b',
      'tr2',
      'tr1',
    ])
  })

  it('does not reorder terminals across projects', () => {
    const terminals = [tab('p1a'), tab('p2a', 'primary', { projectId: 'p2' })]
    expect(reorderTerminalTabs(terminals, 'p1a', 'p2a', 'before')).toBe(terminals)
  })

  it('ensureQuadTerminals does not steal primary sessions into other panes', () => {
    useTerminalStore.setState({
      terminals: [tab('only')],
      activeTerminalId: 'only',
      activeTerminalByProject: { p1: 'only' },
      secondaryTerminalId: null,
      blTerminalId: null,
      brTerminalId: null,
    })
    useTerminalStore.getState().ensureQuadTerminals('p1')
    const s = useTerminalStore.getState()
    expect(s.activeTerminalId).toBe('only')
    expect(s.secondaryTerminalId).toBeNull()
    expect(s.blTerminalId).toBeNull()
    expect(s.brTerminalId).toBeNull()
    expect(terminalPaneOf(s.terminals[0]!)).toBe('primary')
  })

  it('ensureQuadTerminals binds each pane only to sessions it owns', () => {
    useTerminalStore.setState({
      terminals: [
        tab('tl', 'primary'),
        tab('tr', 'secondary'),
        tab('bl', 'bl'),
        tab('br', 'br'),
      ],
      activeTerminalId: 'tl',
      activeTerminalByProject: { p1: 'tl' },
      secondaryTerminalId: 'tr',
      secondaryTerminalByProject: { p1: 'tr' },
      blTerminalId: 'bl',
      blTerminalByProject: { p1: 'bl' },
      brTerminalId: 'br',
      brTerminalByProject: { p1: 'br' },
    })
    useTerminalStore.getState().ensureQuadTerminals('p1')
    const s = useTerminalStore.getState()
    expect(s.activeTerminalId).toBe('tl')
    expect(s.secondaryTerminalId).toBe('tr')
    expect(s.blTerminalId).toBe('bl')
    expect(s.brTerminalId).toBe('br')
  })

  it('setActiveTerminal activates inside the session home pane', () => {
    useTerminalStore.setState({
      terminals: [tab('tl', 'primary'), tab('tr', 'secondary')],
      activeTerminalId: 'tl',
      secondaryTerminalId: 'tr',
      terminalFocusPane: 'primary',
    })
    useTerminalStore.getState().setActiveTerminal('tr')
    const s = useTerminalStore.getState()
    expect(s.terminalFocusPane).toBe('secondary')
    expect(s.secondaryTerminalId).toBe('tr')
    expect(s.activeTerminalId).toBe('tl')
  })

  it('addTerminal assigns ownership to the focused pane', async () => {
    useTerminalStore.setState({ terminalFocusPane: 'br' })
    const id = await useTerminalStore.getState().addTerminal('D:/proj', 'p1')
    expect(id).toBeTruthy()
    const s = useTerminalStore.getState()
    const created = s.terminals.find(t => t.id === id)
    expect(created?.pane).toBe('br')
    expect(s.brTerminalId).toBe(id)
    expect(s.activeTerminalId).toBeNull()
  })

  it('closeOtherTerminals only closes siblings in the same pane', async () => {
    useTerminalStore.setState({
      terminals: [
        tab('p1a', 'primary'),
        tab('p1b', 'primary'),
        tab('tr', 'secondary'),
      ],
      activeTerminalId: 'p1a',
      secondaryTerminalId: 'tr',
    })
    await useTerminalStore.getState().closeOtherTerminals('p1a')
    const s = useTerminalStore.getState()
    expect(s.terminals.map(t => t.id).sort()).toEqual(['p1a', 'tr'])
    expect(s.secondaryTerminalId).toBe('tr')
  })
})
