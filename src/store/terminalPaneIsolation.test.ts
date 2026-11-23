import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeInvoke } from '../lib/tauri'
import { recentShellOpens } from '../lib/terminal/shellOpenDiagnostics'
import { reservePrewarmedShell } from '../lib/terminal/shellPrewarmSettings'
import { ensureTerminalProfileTrust } from '../lib/terminal/terminalProfileTrust'
import { getTerminalProfile } from '../lib/terminal/terminalProfiles'
import type { TerminalTab } from '../types'
import {
  inferTerminalPaneOwnership,
  reorderTerminalTabs,
  terminalPaneOf,
  useTerminalStore,
} from './terminalStore'
import { FAST_PTY_SPAWN_FALLBACK_MS, setTerminalViewGrid } from './terminal/ptySizing'

vi.mock('../lib/terminal/shellPrewarmSettings', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/terminal/shellPrewarmSettings')>(),
  reservePrewarmedShell: vi.fn(async () => ({ reason: 'empty' })),
}))

vi.mock('../lib/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/tauri')>(),
  safeInvoke: vi.fn(async () => undefined),
  isTauri: () => false,
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

const uiMock = vi.hoisted(() => ({ panelLayout: 'sideTerminal', sideDualTerminal: true }))

vi.mock('./uiStore', () => ({
  useUIStore: {
    getState: () => ({
      openTerminalPanel: vi.fn(),
      panelLayout: uiMock.panelLayout,
      sideDualTerminal: uiMock.sideDualTerminal,
      sideQuadTerminal: false,
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
  getTerminalProfile: vi.fn(() => ({
    id: 'default',
    name: 'PowerShell',
    shell: 'powershell',
    command: '',
  })),
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

  it('reserves a local PowerShell for a trusted Claude startup command', async () => {
    const profile = { id: 'assistant', name: 'Claude', command: 'claude', shell: 'pwsh' } as const
    vi.mocked(getTerminalProfile).mockReturnValueOnce(profile).mockReturnValueOnce(profile)
    vi.mocked(reservePrewarmedShell).mockClear().mockResolvedValueOnce({ id: 'warm-claude' })
    vi.mocked(ensureTerminalProfileTrust).mockResolvedValueOnce(false)
    const store = useTerminalStore.getState()
    expect(await store.addTerminal('D:/proj', 'p1')).toBeNull()
    expect(reservePrewarmedShell).not.toHaveBeenCalled()
    expect(await store.addTerminal('D:/proj', 'p1')).toBe('warm-claude')
    expect(reservePrewarmedShell).toHaveBeenCalledWith('D:/proj', expect.any(String), true)
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({
      id: 'warm-claude', profileId: 'assistant', launchCommand: 'claude',
    })
    await store.closeTerminal('warm-claude')
  })

  it.each(['claude', ''])('reserves a remote prewarmed shell for custom profile command %j', async command => {
    const profile = { id: 'assistant', name: 'Custom', command, shell: 'powershell' } as const
    vi.mocked(getTerminalProfile).mockReturnValueOnce(profile)
    vi.mocked(reservePrewarmedShell).mockClear().mockResolvedValueOnce({ id: 'warm-remote' })
    vi.mocked(ensureTerminalProfileTrust).mockResolvedValueOnce(true)
    const path = 'ssh://conn/C:/work/proj'
    expect(await useTerminalStore.getState().addTerminal(path, 'p1')).toBe('warm-remote')
    expect(reservePrewarmedShell).toHaveBeenCalledWith(path, expect.any(String), !!command)
    await useTerminalStore.getState().closeTerminal('warm-remote')
  })

  it('reports the final claim result once and keeps it after tab closure', async () => {
    const projectId = 'prewarm-history'
    const path = 'ssh://conn/D:/work/proj'
    const store = useTerminalStore.getState()
    for (const prewarmHit of [true, false]) {
      const id = `reserved-${prewarmHit}`
      vi.mocked(reservePrewarmedShell).mockResolvedValueOnce({ id })
      expect(await store.addTerminal(path, projectId)).toBe(id)
      vi.mocked(safeInvoke).mockResolvedValueOnce({ prewarmHit })
      await store.spawnPendingTerminal(id, 80, 24)
      await store.spawnPendingTerminal(id, 80, 24)
      await store.closeTerminal(id)
    }
    expect(recentShellOpens(projectId)).toMatchObject({
      hit: { count: 1 }, miss: { count: 1 }, missReasons: { claim_fallback: 1 },
    })
  })

  it('spawns a reserved prewarmed shell without waiting for a late fit', async () => {
    vi.useFakeTimers()
    const original = useTerminalStore.getState().spawnPendingTerminal
    const spawn = vi.fn(async () => {})
    try {
      // 同窗格已有终端：兜底启动按它的视图网格估计尺寸。
      setTerminalViewGrid('sibling', { cols: 150, rows: 40 })
      useTerminalStore.setState({
        terminals: [tab('sibling', 'primary')],
        activeTerminalId: 'sibling',
        spawnPendingTerminal: spawn,
      })
      vi.mocked(reservePrewarmedShell).mockClear().mockResolvedValueOnce({ id: 'warm-bg' })
      expect(await useTerminalStore.getState().addTerminal('ssh://conn/D:/work/proj', 'p1')).toBe('warm-bg')
      await vi.advanceTimersByTimeAsync(FAST_PTY_SPAWN_FALLBACK_MS)
      expect(spawn).toHaveBeenCalledWith('warm-bg', 150, 40)

      // 未领取到预热项时保持原来的 2.5s 兜底，等视图 fit 给出真实尺寸。
      spawn.mockClear()
      const cold = await useTerminalStore.getState().addTerminal('D:/proj', 'p1')
      await vi.advanceTimersByTimeAsync(FAST_PTY_SPAWN_FALLBACK_MS)
      expect(spawn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2500)
      expect(spawn).toHaveBeenCalledWith(cold, expect.any(Number), expect.any(Number))
    } finally {
      setTerminalViewGrid('sibling', null)
      useTerminalStore.setState({ spawnPendingTerminal: original })
      vi.useRealTimers()
    }
  })

  it.each(['codex', 'claude'])('starts a cold %s profile while its view mounts', async command => {
    vi.useFakeTimers()
    const original = useTerminalStore.getState().spawnPendingTerminal
    const spawn = vi.fn(async () => {})
    try {
      setTerminalViewGrid('sibling', { cols: 144, rows: 36 })
      useTerminalStore.setState({
        terminals: [tab('sibling', 'primary')], activeTerminalId: 'sibling', spawnPendingTerminal: spawn,
      })
      const profile = { id: command, name: command, command, shell: 'pwsh' } as const
      vi.mocked(getTerminalProfile).mockReturnValueOnce(profile).mockReturnValueOnce(profile)
      const store = useTerminalStore.getState()
      const first = await store.addTerminal('D:/proj', 'p1', command)
      setTerminalViewGrid('sibling', null)
      await vi.advanceTimersByTimeAsync(0)
      expect(spawn).toHaveBeenCalledWith(first, 144, 36)
      spawn.mockClear()
      const second = await store.addTerminal('D:/proj', 'p1', command)
      await vi.advanceTimersByTimeAsync(FAST_PTY_SPAWN_FALLBACK_MS - 1)
      expect(spawn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith(second, expect.any(Number), expect.any(Number))
    } finally {
      setTerminalViewGrid('sibling', null)
      useTerminalStore.setState({ spawnPendingTerminal: original })
      vi.useRealTimers()
    }
  })

  it('restart claims a prewarmed shell under the same tab id', async () => {
    const path = 'ssh://conn/D:/work/proj'
    useTerminalStore.setState({ terminals: [tab('t-claude', 'primary', {
      cwd: path, profileId: 'assistant', launchCommand: 'claude', shell: 'powershell', status: 'exited',
    })] })
    vi.mocked(reservePrewarmedShell).mockClear().mockResolvedValueOnce({ id: 't-claude' })
    await useTerminalStore.getState().restartTerminal('t-claude')
    expect(reservePrewarmedShell).toHaveBeenCalledWith(path, 'powershell', true, 't-claude')
    expect(useTerminalStore.getState().terminals).toMatchObject([
      { id: 't-claude', status: 'starting', prewarm: { outcome: 'reserved' } },
    ])
    await useTerminalStore.getState().closeTerminal('t-claude')
  })

  it('restart keeps run tasks and profiles with extra env on the normal spawn path', async () => {
    vi.mocked(reservePrewarmedShell).mockClear()
    for (const extras of [
      { shellKind: 'command', launchCommand: 'pnpm dev' },
      { profileId: 'assistant', launchCommand: 'claude', env: { API: '1' } },
    ] as const) {
      useTerminalStore.setState({ terminals: [tab('t-task', 'primary', { ...extras, status: 'exited' })] })
      await useTerminalStore.getState().restartTerminal('t-task')
      expect(useTerminalStore.getState().terminals[0].prewarm).toEqual({ outcome: 'miss', reason: 'restart' })
      await useTerminalStore.getState().closeTerminal('t-task')
    }
    expect(reservePrewarmedShell).not.toHaveBeenCalled()
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

  describe.each([
    ['classic', 'classic', true],
    ['single side terminal', 'sideTerminal', false],
    ['workbench', 'terminalWorkbench', true],
  ])('with one visible pane (%s)', (_name, panelLayout, sideDualTerminal) => {
    beforeEach(() => {
      uiMock.panelLayout = panelLayout
      uiMock.sideDualTerminal = sideDualTerminal
    })
    afterEach(() => {
      uiMock.panelLayout = 'sideTerminal'
      uiMock.sideDualTerminal = true
    })

    it('treats every session as primary without rewriting ownership', () => {
      const session = tab('b', 'secondary')
      expect(terminalPaneOf(session)).toBe('primary')
      expect(session.pane).toBe('secondary')
    })

    it('activates a session owned by a hidden pane', () => {
      useTerminalStore.setState({
        terminals: [tab('a', 'primary'), tab('b', 'secondary')],
        activeTerminalId: 'a',
        secondaryTerminalId: 'b',
      })
      useTerminalStore.getState().setActiveTerminal('b')
      const state = useTerminalStore.getState()
      expect(state.activeTerminalId).toBe('b')
      expect(state.terminalFocusPane).toBe('primary')
      expect(state.terminals.find(t => t.id === 'b')?.pane).toBe('secondary')
    })

    it('hands the active slot to a session from a hidden pane when the last primary closes', async () => {
      useTerminalStore.setState({
        terminals: [tab('a', 'primary'), tab('b', 'secondary')],
        activeTerminalId: 'a',
        activeTerminalByProject: { p1: 'a' },
      })
      await useTerminalStore.getState().closeTerminal('a')
      expect(useTerminalStore.getState().activeTerminalId).toBe('b')
    })

    it('closes every other visible session', async () => {
      useTerminalStore.setState({
        terminals: [tab('a', 'primary'), tab('b', 'secondary'), tab('c', 'bl')],
        activeTerminalId: 'a',
      })
      await useTerminalStore.getState().closeOtherTerminals('a')
      expect(useTerminalStore.getState().terminals.map(t => t.id)).toEqual(['a'])
    })

    it('keeps hidden pane bindings when the project is reactivated', () => {
      useTerminalStore.setState({
        terminals: [tab('a', 'primary'), tab('b', 'secondary'), tab('c', 'secondary')],
        activeTerminalByProject: { p1: 'a' },
        secondaryTerminalByProject: { p1: 'c' },
      })
      useTerminalStore.getState().activateProject('p1')
      const state = useTerminalStore.getState()
      expect(state.activeTerminalId).toBe('a')
      expect(state.secondaryTerminalId).toBe('c')
    })
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
  it('removeEndedTerminal drops the tab and rebinds the pane without killing the process', () => {
    useTerminalStore.setState({
      terminals: [tab('gone', 'primary', { cwd: 'ssh://conn/proj', status: 'exited' }), tab('kept', 'primary')],
      activeTerminalId: 'gone',
      activeTerminalByProject: { p1: 'gone' },
    })
    vi.mocked(safeInvoke).mockClear()
    useTerminalStore.getState().removeEndedTerminal('gone')
    const s = useTerminalStore.getState()
    expect(s.terminals.map(t => t.id)).toEqual(['kept'])
    expect(s.activeTerminalId).toBe('kept')
    expect(s.activeTerminalByProject).toEqual({ p1: 'kept' })
    expect(safeInvoke).not.toHaveBeenCalled()
  })
})
