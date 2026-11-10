import { describe, expect, it } from 'vitest'
import { buildPairingLink, formatFingerprint } from './mobilePairing'
// Android WebView 资产与桌面共用同一套配对链接格式。
import {
  createdLabel,
  formatTerminalQuote,
  formatDuration,
  idleLabel,
  MODIFIER_LOCK_WINDOW,
  PULL_MAX,
  PULL_THRESHOLD,
  applyModifiers,
  attachNeedsRedraw,
  avatarFor,
  consumeModifier,
  findPortMovedProfile,
  countSessionOverview,
  groupSessionOverview,
  limitSessionGroups,
  keySequence,
  matchesProject,
  nextModifierState,
  orderSessions,
  joinProjectIds,
  parseIdList,
  phoneSessionProjectIds,
  reorderSessionIds,
  reorderVisibleProjects,
  updateSessionAttention,
  outputBatches,
  outputChunk,
  parsePairingLink,
  parseSessionPins,
  prunedSessionPins,
  projectSessionsFromOverview,
  prunedSelection,
  summarizeSessionBatch,
  SESSION_PIN_LIMIT,
  projectSourceLabel,
  groupProjectsByHost,
  projectLocation,
  sessionIdleInfo,
  sessionStatusLine,
  swipeRevealOffset,
  swipeRevealSettles,
  recentProjects,
  rememberProject,
  pullOffset,
  renameProfileKeys,
  sessionName,
  sessionRunning,
  mergeSessionActivity,
  mergeSessionName,
  splitInput,
  terminalProfileChoices,
  terminalGridSize,
  toggleSessionPin,
} from '../../mobile/android/web/protocol.js'

const fingerprint = '0123456789abcdef'.repeat(4)

describe('Android port-moved profile', () => {
  const old = { id: '192.168.1.5:8765', host: '192.168.1.5', port: 8765, fingerprint }

  it('finds the same computer saved under its previous port', () => {
    expect(findPortMovedProfile([old], '192.168.1.5', 9000, fingerprint)).toBe(old)
  })

  it('ignores other hosts, other certificates and an existing target address', () => {
    expect(findPortMovedProfile([old], '192.168.1.6', 9000, fingerprint)).toBeNull()
    expect(findPortMovedProfile([old], '192.168.1.5', 9000, 'f'.repeat(64))).toBeNull()
    expect(findPortMovedProfile([old], '192.168.1.5', 8765, fingerprint)).toBeNull()
    const current = { ...old, id: '192.168.1.5:9000', port: 9000 }
    expect(findPortMovedProfile([old, current], '192.168.1.5', 9000, fingerprint)).toBeNull()
  })
})

describe('Android terminal content-box sizing', () => {
  it('keeps complete rows within the space left after viewport padding', () => {
    expect(terminalGridSize(360, 510.5, 7.8, 15.6)).toEqual({ cols: 46, rows: 32 })
    expect(terminalGridSize(360, 614.5, 7.8, 15.6)).toEqual({ cols: 46, rows: 39 })
  })

  it('keeps fixed columns, matches native limits and skips hidden measurements', () => {
    expect(terminalGridSize(280, 300, 8, 16, 100)).toEqual({ cols: 100, rows: 18 })
    expect(terminalGridSize(9000, 9000, 1, 1)).toEqual({ cols: 300, rows: 150 })
    expect(terminalGridSize(0, 300, 8, 16)).toBeNull()
    expect(terminalGridSize(280, 300, NaN, 16)).toBeNull()
  })
})

describe('Android attach redraw', () => {
  const local = { cols: 46, rows: 32 }

  it('redraws when the session grid differs from this device', () => {
    expect(attachNeedsRedraw({ data: 'x', cols: 100, rows: 32 }, local)).toBe(true)
    expect(attachNeedsRedraw({ data: 'x', cols: 46, rows: 40 }, local)).toBe(true)
  })

  it('keeps the normal path for a matching grid or a chunk without a grid', () => {
    expect(attachNeedsRedraw({ data: 'x', cols: 46, rows: 32 }, local)).toBe(false)
    expect(attachNeedsRedraw('YmFzZTY0', local)).toBe(false)
    expect(attachNeedsRedraw(undefined, local)).toBe(false)
  })
})

describe('Android session names', () => {
  it('replaces CLI title frames with independent running indicators for every session', () => {
    for (const frame of ['⠋', '⠙', '⠇', '⠿']) {
      const session = { name: frame + ' 优化输入框 | QingCode' }
      expect(sessionRunning(session)).toBe(true)
      expect(sessionName(session)).toBe('优化输入框 | QingCode')
    }
    expect(sessionRunning({ name: '等待输入' })).toBe(false)
    expect(sessionRunning({ name: '⠋ 构建', exit: { exitCode: 0 } })).toBe(false)
    expect(sessionRunning({ name: '自定名称', customName: '自定名称', programTitle: '⠋ 构建' })).toBe(true)
    expect(sessionName({ name: '⠋ 我的名字', customName: '⠋ 我的名字' })).toBe('⠋ 我的名字')
    expect(sessionRunning({ name: '⠋ 我的名字', customName: '⠋ 我的名字' })).toBe(false)
    expect(sessionRunning({})).toBe(false)
    expect(sessionName({ name: '⠋', number: 2 })).toBe('终端 2')
  })

  it('prefers the smoothed programBusy flag and keeps non-spinner title glyphs', () => {
    // 电脑端判定仍在忙时，标题暂时没有转圈帧也继续转；判定空闲时，残留的转圈帧不再转。
    expect(sessionRunning({ name: '✳ Claude Code', programTitle: '✳ Claude Code', programBusy: true })).toBe(true)
    expect(sessionRunning({ name: '⠋ 构建', programTitle: '⠋ 构建', programBusy: false })).toBe(false)
    expect(sessionRunning({ name: '⠋ 构建', programBusy: true, exit: { exitCode: 0 } })).toBe(false)
    // 旧版电脑端没有 programBusy：空白盲文帧与圆形转圈也算转圈帧。
    expect(sessionRunning({ name: 'BLANK 构建'.replace('BLANK', String.fromCharCode(0x2800)) })).toBe(true)
    expect(sessionRunning({ name: '◐ Claude Code' })).toBe(true)
    expect(sessionName({ name: '◓ Claude Code' })).toBe('Claude Code')
    expect(sessionName({ name: '✳ Claude Code' })).toBe('Claude Code')
  })

  it('merges busy state regardless of the name revision', () => {
    const session = { name: 'Claude', nameRevision: 5, programBusy: true }
    expect(mergeSessionActivity(session, { nameRevision: 4, programBusy: false })).toBe(true)
    expect(session.programBusy).toBe(false)
    expect(mergeSessionActivity(session, { programBusy: false })).toBe(false)
    expect(mergeSessionActivity(session, {})).toBe(false)
    expect(mergeSessionActivity(undefined, { programBusy: true })).toBe(false)
  })

  it('rejects out-of-order activity without blocking expiry at the same name revision', () => {
    const session = { name: '✳ Claude', nameRevision: 4, programBusy: true, activityRevision: 2 }
    expect(mergeSessionActivity(session, { nameRevision: 4, programBusy: false, activityRevision: 4 })).toBe(true)
    expect(mergeSessionActivity(session, { nameRevision: 4, programBusy: true, activityRevision: 3 })).toBe(false)
    expect(mergeSessionActivity(session, { programBusy: true })).toBe(false)
    expect(session.programBusy).toBe(false)
    expect(mergeSessionActivity(session, { programBusy: false, activityRevision: 5 })).toBe(false)
    expect(session.activityRevision).toBe(5)
    expect(mergeSessionActivity(session, { programBusy: true, activityRevision: 4 })).toBe(false)
  })

  it('updates activity behind a manual name without accepting an older title', () => {
    const session = { name: '构建', customName: '构建', nameRevision: 3, programTitle: '⠋ 工作' }
    expect(mergeSessionName(session, { ...session, programTitle: '完成', nameRevision: 4 })).toBe(true)
    expect(sessionRunning(session)).toBe(false)
    expect(mergeSessionName(session, { ...session, programTitle: '⠙ 旧状态', nameRevision: 3 })).toBe(false)
    expect(session.programTitle).toBe('完成')
  })

  it('uses server names and falls back to numbered sessions for older desktops', () => {
    expect(sessionName({ name: '修复登录', number: 3 })).toBe('修复登录')
    expect(sessionName({ number: 3 })).toBe('终端 3')
    expect(sessionName({}, 4)).toBe('终端 4')
  })

  it('keeps manual names when an older poll arrives after rename', () => {
    const session = { name: 'OpenCode', customName: null, nameRevision: 1 }
    expect(mergeSessionName(session, { name: '登录', customName: '登录', nameRevision: 3 })).toBe(true)
    expect(mergeSessionName(session, { name: 'Claude', customName: null, nameRevision: 2 })).toBe(false)
    expect(session.name).toBe('登录')
    expect(mergeSessionName(session, {})).toBe(false)
    expect(mergeSessionName(session, { name: 'Claude', customName: null, nameRevision: 4 })).toBe(true)
    expect(session.name).toBe('Claude')
  })
})

describe('Android recent projects', () => {
  it('orders phone and desktop opens by time and caps the result at ten', () => {
    const projects = Array.from({ length: 15 }, (_, i) => ({ id: String(i), lastOpenedAt: i + 1 }))
    const result = recentProjects(projects, [{ id: '0', openedAt: 30 }, { id: 'removed', openedAt: 100 }])
    expect(result.map(item => item.id)).toEqual(['0', '14', '13', '12', '11', '10', '9', '8', '7', '6'])
    expect(projects[0].id).toBe('0')
  })

  it('handles older desktops and damaged history without inventing opens', () => {
    const projects = [{ id: 'old' }, { id: 'new', lastOpenedAt: 20 }, { id: 'invalid', lastOpenedAt: NaN }]
    expect(recentProjects(projects, null).map(item => item.id)).toEqual(['new'])
    expect(recentProjects(projects, [null, { id: 'old', openedAt: 30 }, { id: 'new', openedAt: 'bad' }])
      .map(item => item.id)).toEqual(['old', 'new'])
  })

  it('moves reopened projects to the top and bounds persisted history', () => {
    let history = null
    for (let i = 0; i < 15; i++) history = rememberProject(history, String(i), i + 1)
    history = rememberProject(history, '8', 30)
    expect(history).toHaveLength(10)
    expect(history[0]).toEqual({ id: '8', openedAt: 30 })
    expect(history.filter(item => item.id === '8')).toHaveLength(1)
  })
})

describe('Android session row idle text', () => {
  const hour = 3_600_000
  const now = 100 * hour

  it('only says how long the session has been idle while far from auto-end', () => {
    expect(sessionIdleInfo({ lastActiveAt: now - 13 * 60000, idleDeadline: now + 20 * hour }, now)).toEqual({ text: '空闲 13 分钟', expiring: false })
    expect(sessionIdleInfo({ lastActiveAt: now - 1000, idleDeadline: now + 24 * hour }, now)).toEqual({ text: '刚刚有活动', expiring: false })
  })

  it('adds the countdown within two hours of auto-end', () => {
    const near = sessionIdleInfo({ lastActiveAt: now - 22 * hour, idleDeadline: now + 2 * hour }, now)
    expect(near.expiring).toBe(true)
    expect(near.text).toBe('空闲 22 小时，2 小时后自动结束')
  })

  it('shows nothing for exited sessions or old desktops', () => {
    expect(sessionIdleInfo({ exit: { code: 0 }, idleDeadline: now + hour }, now)).toEqual({ text: '', expiring: false })
    expect(sessionIdleInfo({ lastActiveAt: now }, now)).toEqual({ text: '', expiring: false })
  })
})

describe('Android project display', () => {
  it('shows remote Windows paths the Windows way and only strips the ssh resource prefix elsewhere', () => {
    expect(projectLocation({ kind: 'ssh', path: 'ssh://conn/D:/code/qingcode' })).toBe('D:\\code\\qingcode')
    expect(projectLocation({ kind: 'ssh', path: 'ssh://conn/home/code/django' })).toBe('/home/code/django')
    expect(projectLocation({ kind: 'local', path: 'D:\\code\\qingcode' })).toBe('D:\\code\\qingcode')
    expect(projectLocation({ kind: 'wsl', path: '/home/code' })).toBe('/home/code')
  })

  it('finds remote Windows projects by the displayed path', () => {
    expect(matchesProject({ name: 'x', kind: 'ssh', path: 'ssh://conn/D:/code/x' }, 'd:\\code')).toBe(true)
  })

  it('groups projects by host in first-seen order and keeps same-name projects apart', () => {
    const groups = groupProjectsByHost([
      { id: '1', name: 'django', kind: 'ssh', connectionName: 'WSL', host: 'localhost' },
      { id: '2', name: 'django', kind: 'ssh', connectionName: 'WinDev', host: '192.168.252.107' },
      { id: '3', name: 'QingCode', kind: 'local', host: 'Windows' },
      { id: '4', name: 'nem-panel', kind: 'ssh', connectionName: 'WSL', host: 'localhost' },
      { id: '5', name: 'local-two', kind: 'local', host: 'Other' },
    ])
    expect(groups.map(group => group.items.map(item => item.id))).toEqual([['1', '4'], ['2'], ['3', '5']])
    expect(groups.map(group => group.label)).toEqual(['远端 · WSL · localhost', '远端 · WinDev · 192.168.252.107', '本机'])
  })
})

describe('Android swipe-to-reveal rows', () => {
  const width = 76

  it('follows the finger, never moves right of rest, and resists past fully open', () => {
    expect(swipeRevealOffset(0, 30, width)).toBe(0)
    expect(swipeRevealOffset(0, -30, width)).toBe(-30)
    expect(swipeRevealOffset(-width, 20, width)).toBe(-56)
    expect(swipeRevealOffset(0, -106, width)).toBe(-86)
  })

  it('settles open once more than half is revealed', () => {
    expect(swipeRevealSettles(-38, width)).toBe(true)
    expect(swipeRevealSettles(-37, width)).toBe(false)
  })
})

describe('Android project sources', () => {
  const wslRemote = {
    name: 'django', kind: 'ssh', path: 'ssh://wsl-connection/home/code/django',
    host: 'localhost', connectionName: 'WSL',
  }

  it('distinguishes remote projects by connection name and host', () => {
    expect(projectSourceLabel(wslRemote)).toBe('远端 · WSL · localhost')
    expect(projectSourceLabel({ ...wslRemote, connectionName: 'WinDev', host: '192.168.252.107' }))
      .toBe('远端 · WinDev · 192.168.252.107')
    expect(projectSourceLabel({ kind: 'wsl', host: 'Ubuntu' })).toBe('WSL · Ubuntu')
    expect(projectSourceLabel({ kind: 'local', host: 'Windows' })).toBe('本机')
  })

  it('supports an older desktop without connection names', () => {
    expect(projectSourceLabel({ kind: 'ssh', host: '192.168.252.107' })).toBe('远端 · 192.168.252.107')
    expect(matchesProject({ name: 'app', kind: 'ssh' }, 'app')).toBe(true)
  })

  it('searches connection names, addresses and paths in a single project list', () => {
    for (const query of [' wSl ', 'LOCALHOST', '/home/code/django', 'django']) {
      expect(matchesProject(wslRemote, query)).toBe(true)
    }
    expect(matchesProject(wslRemote, 'WinDev')).toBe(false)
    expect(matchesProject({ ...wslRemote, host: '192.168.252.107' }, '252.107')).toBe(true)
  })
})

describe('Android pairing link', () => {
  it('round-trips the desktop link including unicode computer names', () => {
    const link = buildPairingLink({ host: '192.168.1.8', port: 48764, fingerprint, name: '工作 PC&1' })
    expect(parsePairingLink(link)).toEqual({ host: '192.168.1.8', port: 48764, fingerprint, name: '工作 PC&1' })
    expect(parsePairingLink(link.replace(fingerprint, fingerprint.toUpperCase())).fingerprint).toBe(fingerprint)
  })

  it('rejects foreign links and invalid fields', () => {
    expect(() => parsePairingLink('https://example.com')).toThrow('不是 QingCode 配对链接')
    expect(() => parsePairingLink(`qingcode://pair?v=2&host=1.2.3.4&port=1&fp=${fingerprint}`)).toThrow('版本')
    for (const host of ['1.2.3', '256.1.1.1', '01.2.3.4', 'example.com']) {
      expect(() => parsePairingLink(`qingcode://pair?v=1&host=${host}&port=48764&fp=${fingerprint}`)).toThrow('地址')
    }
    expect(() => parsePairingLink(`qingcode://pair?v=1&host=1.2.3.4&port=70000&fp=${fingerprint}`)).toThrow('地址')
    expect(() => parsePairingLink('qingcode://pair?v=1&host=1.2.3.4&port=1&fp=abc')).toThrow('指纹')
  })

  it('groups fingerprints for visual comparison', () => {
    expect(formatFingerprint('abcdef012345')).toBe('abcd ef01 2345')
  })
})

describe('Android terminal protocol', () => {
  it('decodes byte chunks and passes screen snapshots through as text', () => {
    const bytes = outputChunk(btoa('hi\r\n'))
    expect(bytes.screen).toBe(false)
    expect(Array.from(bytes.data as Uint8Array)).toEqual([104, 105, 13, 10])
    // 屏幕快照含原始 ESC 序列；按 base64 解码会抛错并让轮询卡死。
    expect(outputChunk({ data: '\x1b[2Jprompt$ ', cols: 80, rows: 24 })).toEqual({
      screen: true, data: '\x1b[2Jprompt$ ', cols: 80, rows: 24,
    })
  })

  it('merges adjacent byte chunks into one write and keeps snapshots separate', () => {
    // 「中」的 UTF-8 三个字节跨块拆开，合并后仍完整。
    const bytes = new TextEncoder().encode('a中')
    const raw = (part: Uint8Array) => btoa(String.fromCharCode(...part))
    const batches = outputBatches([raw(bytes.slice(0, 2)), raw(bytes.slice(2)), { data: 'snap', cols: 80, rows: 24 }, btoa('b'), btoa('c')])
    expect(batches).toHaveLength(3)
    expect(new TextDecoder().decode(batches[0].data as Uint8Array)).toBe('a中')
    expect(batches[1]).toEqual({ screen: true, data: 'snap', cols: 80, rows: 24 })
    expect(new TextDecoder().decode(batches[2].data as Uint8Array)).toBe('bc')
    expect(outputBatches([])).toEqual([])
  })

  it('splits input without breaking surrogate pairs', () => {
    const text = 'a'.repeat(3) + '😀' + 'b'
    const parts = splitInput(text, 4)
    expect(parts.join('')).toBe(text)
    expect(parts[0]).toBe('aaa')
    expect(parts[1].startsWith('😀')).toBe(true)
    expect(splitInput('')).toEqual([])
  })

  it('maps one-shot Ctrl and Alt modifiers', () => {
    expect(applyModifiers('c', { ctrl: true })).toBe('\x03')
    expect(applyModifiers('[', { ctrl: true })).toBe('\x1b')
    expect(applyModifiers(' ', { ctrl: true })).toBe('\x00')
    expect(applyModifiers('?', { ctrl: true })).toBe('\x7f')
    expect(applyModifiers('b', { alt: true })).toBe('\x1bb')
    expect(applyModifiers('x', { ctrl: true, alt: true })).toBe('\x1b\x18')
    expect(applyModifiers('ab', { ctrl: true })).toBe('ab')
  })

  it('emits cursor and paging sequences in both cursor modes', () => {
    expect(keySequence('up')).toBe('\x1b[A')
    expect(keySequence('up', { applicationCursor: true })).toBe('\x1bOA')
    expect(keySequence('home')).toBe('\x1b[H')
    expect(keySequence('end', { applicationCursor: true })).toBe('\x1bOF')
    expect(keySequence('pgup')).toBe('\x1b[5~')
    expect(keySequence('pgdn', { applicationCursor: true })).toBe('\x1b[6~')
    expect(keySequence('esc')).toBe('\x1b')
    expect(keySequence('backspace')).toBe('\x7f')
    expect(keySequence('shift-tab')).toBe('\x1b[Z')
    expect(keySequence('shift-left')).toBe('\x1b[1;2D')
    expect(keySequence('shift-left', { applicationCursor: true })).toBe('\x1b[1;2D')
    expect(keySequence('delete-word')).toBe('\x17')
    expect(keySequence('delete-line-start')).toBe('\x15')
    expect(keySequence('clear-input')).toBe('\x05\x15')
    expect(keySequence('clear-input', { applicationCursor: true })).toBe('\x05\x15')
    expect(keySequence('newline')).toBe('\n')
    expect(() => keySequence('f1')).toThrow()
  })

  it('clears a detected Windows PowerShell input using its default PSReadLine bindings', () => {
    for (const inputLine of ['PS D:\\Code\\QingCode> long command', 'PS \\\\host\\share> command']) {
      expect(keySequence('clear-input', { inputLine })).toBe('\x1b[1;5H\x1b[1;5F')
    }
    for (const inputLine of ['$ command', 'PS /home/user> command', 'text with PS D:\\Code> inside', '╭─ Codex']) {
      expect(keySequence('clear-input', { inputLine })).toBe('\x05\x15')
    }
  })

  it('moves per-connection records when the address changes', () => {
    const prefix = 'qingcode:mobile:'
    const keys = [
      `${prefix}session:1.2.3.4:48764:p1`,
      `${prefix}project:1.2.3.4:48764`,
      `${prefix}session:1.2.3.4:487640:p1`,
      `${prefix}active`,
      `${prefix}recent-projects:1.2.3.4:48764`,
      `${prefix}session-pins:1.2.3.4:48764:p1`,
    ]
    expect(renameProfileKeys(keys, prefix, '1.2.3.4:48764', '1.2.3.4:49000')).toEqual([
      [keys[0], `${prefix}session:1.2.3.4:49000:p1`],
      [keys[1], `${prefix}project:1.2.3.4:49000`],
      [keys[4], `${prefix}recent-projects:1.2.3.4:49000`],
      [keys[5], `${prefix}session-pins:1.2.3.4:49000:p1`],
    ])
  })
})

describe('Android session pins', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('puts pinned sessions first in pin order and keeps desktop order for the rest', () => {
    expect(orderSessions(list, ['c', 'a']).map(item => [item.session.id, item.index])).toEqual([
      ['c', 2], ['a', 0], ['b', 1], ['d', 3],
    ])
    expect(orderSessions(list).map(item => item.session.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(orderSessions(list, ['gone']).map(item => item.session.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('toggles pins with the newest pin on top', () => {
    expect(toggleSessionPin([], 'a')).toEqual(['a'])
    expect(toggleSessionPin(['a'], 'b')).toEqual(['b', 'a'])
    expect(toggleSessionPin(['b', 'a'], 'b')).toEqual(['a'])
    const full = Array.from({ length: SESSION_PIN_LIMIT }, (_, index) => String(index))
    expect(toggleSessionPin(full, 'new')).toHaveLength(SESSION_PIN_LIMIT)
    expect(toggleSessionPin(full, 'new')[0]).toBe('new')
  })

  it('reads damaged storage as no pins and drops sessions that no longer exist', () => {
    expect(parseSessionPins(null)).toEqual([])
    expect(parseSessionPins('{bad')).toEqual([])
    expect(parseSessionPins('{"a":1}')).toEqual([])
    expect(parseSessionPins('["a", 3, "", "a", "b"]')).toEqual(['a', 'b'])
    expect(prunedSessionPins(['x', 'b', 'a'], list)).toEqual(['b', 'a'])
  })
})

describe('Android extra-key modifiers (Termux-style lock)', () => {
  it('cycles off → once → lock on a double tap and releases on the next tap', () => {
    const first = nextModifierState('off', 1000)
    expect(first).toEqual({ state: 'once', at: 1000 })
    const second = nextModifierState(first.state, 1000 + MODIFIER_LOCK_WINDOW, first.at)
    expect(second.state).toBe('lock')
    expect(nextModifierState(second.state, 5000, second.at).state).toBe('off')
  })

  it('treats a slow second tap as cancelling the one-shot modifier', () => {
    expect(nextModifierState('once', 2000, 2000 - MODIFIER_LOCK_WINDOW - 1).state).toBe('off')
  })

  it('consumes one-shot modifiers but keeps locked ones', () => {
    expect(consumeModifier('once')).toBe('off')
    expect(consumeModifier('off')).toBe('off')
    expect(consumeModifier('lock')).toBe('lock')
  })
})

describe('Android pull to refresh', () => {
  it('ignores upward or zero movement', () => {
    expect(pullOffset(0)).toBe(0)
    expect(pullOffset(-40)).toBe(0)
    expect(pullOffset(Number.NaN)).toBe(0)
  })

  it('damps the pull, crosses the threshold with a deliberate drag and never exceeds the maximum', () => {
    expect(pullOffset(60)).toBeLessThan(60)
    expect(pullOffset(80)).toBeLessThan(PULL_THRESHOLD)
    expect(pullOffset(150)).toBeGreaterThanOrEqual(PULL_THRESHOLD)
    expect(pullOffset(10_000)).toBeLessThanOrEqual(PULL_MAX)
    expect(pullOffset(100)).toBeGreaterThan(pullOffset(90))
  })
})

describe('Android connection avatars', () => {
  it('uses the first character for CJK names and two initials for multi-word names', () => {
    expect(avatarFor('工作电脑').initials).toBe('工')
    expect(avatarFor('build server').initials).toBe('BS')
    expect(avatarFor('DEVBOX').initials).toBe('D')
    expect(avatarFor('').initials).toBe('?')
  })

  it('keeps a stable colour per name within the palette', () => {
    expect(avatarFor('WinDev').hue).toBe(avatarFor('WinDev').hue)
    for (const name of ['a', 'WSL', '工作电脑', 'build server', '🙂 home']) {
      const { hue } = avatarFor(name)
      expect(Number.isInteger(hue) && hue >= 0 && hue < 6).toBe(true)
    }
  })
})
describe('mobile terminal profiles', () => {
  it('keeps desktop profile ids and names only, in order and without duplicates', () => {
    expect(terminalProfileChoices([
      { id: 'default', name: '普通终端', trusted: true },
      { id: 'claude', name: ' Claude ', trusted: true, command: 'claude' },
      { id: 'claude', name: 'dup' },
      { id: 'ops', name: '  ', trusted: false },
      { id: '', name: 'bad' }, null, { name: 'no id' },
    ])).toEqual([
      { id: 'default', name: '普通终端', trusted: true },
      { id: 'claude', name: 'Claude', trusted: true },
      { id: 'ops', name: '未命名配置', trusted: false },
    ])
  })

  it('falls back to a plain terminal when the desktop has no profile list', () => {
    const plain = [{ id: null, name: '新建终端', trusted: true }]
    expect(terminalProfileChoices(null)).toEqual(plain)
    expect(terminalProfileChoices([])).toEqual(plain)
    expect(terminalProfileChoices({ error: 'old' })).toEqual(plain)
  })
})

describe('Android 终端空闲自动结束提示', () => {
  const hour = 3600_000
  it('时长格式', () => {
    expect(formatDuration(20_000)).toBe('不到 1 分钟')
    expect(formatDuration(25 * 60_000)).toBe('25 分钟')
    expect(formatDuration(2 * hour + 15 * 60_000)).toBe('2 小时 15 分')
    expect(formatDuration(21 * hour + 59 * 60_000)).toBe('21 小时')
    expect(formatDuration(23 * hour + 59 * 60_000 + 30_000, true)).toBe('24 小时')
    expect(formatDuration(90_000, true)).toBe('2 分钟')
  })

  it('显示空闲时长与剩余时间，已结束或旧电脑端不显示', () => {
    const now = 1_000 * hour
    expect(idleLabel({ lastActiveAt: now - 3 * hour, idleDeadline: now + 21 * hour }, now)).toBe('空闲 3 小时，21 小时后自动结束')
    expect(idleLabel({ lastActiveAt: now - 10_000, idleDeadline: now - 10_000 + 24 * hour }, now)).toBe('刚刚有活动，24 小时后自动结束')
    expect(idleLabel({ lastActiveAt: now - 25 * hour, idleDeadline: now - hour }, now)).toBe('空闲 25 小时，即将自动结束')
    expect(idleLabel({ idleDeadline: now + hour }, now)).toBe('1 小时后自动结束')
    expect(idleLabel({ lastActiveAt: now }, now)).toBe('')
    expect(idleLabel(null, now)).toBe('')
  })

  it('手机时钟慢于电脑端时剩余时间不超过空闲窗口', () => {
    const now = 1_000 * hour
    for (const skew of [1, 30_000, 5 * 60_000]) {
      const lastActiveAt = now + skew
      expect(idleLabel({ lastActiveAt, idleDeadline: lastActiveAt + 24 * hour }, now)).toBe('刚刚有活动，24 小时后自动结束')
    }
  })
})

describe('Android terminal quote', () => {
  it('matches the desktop Markdown quote format', () => {
    expect(formatTerminalQuote('\r\n  a  \r\n\r\nb\n\n')).toBe('>   a\n>\n> b\n')
    expect(formatTerminalQuote('   \n ')).toBe('')
  })
})

describe('Android 侧栏项目与手动排序', () => {
  it('解析本地 id 列表时容错、去重并限制数量', () => {
    expect(parseIdList('oops')).toEqual([])
    expect(parseIdList('{"a":1}')).toEqual([])
    expect(parseIdList('["a","a",1,"","b"]')).toEqual(['a', 'b'])
    expect(parseIdList(JSON.stringify(Array.from({ length: 150 }, (_, i) => `p${i}`)))).toHaveLength(100)
  })

  it('新项目追加在末尾，已有项目不动', () => {
    expect(joinProjectIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('项目拖动只在可见项目间换位，看不到的留在原位', () => {
    expect(reorderVisibleProjects(['a', 'hidden', 'b', 'c'], ['a', 'b', 'c'], 2, 0)).toEqual(['c', 'hidden', 'a', 'b'])
    expect(reorderVisibleProjects(['a', 'b'], ['a', 'b'], 0, 1)).toEqual(['b', 'a'])
  })

  it('终端拖动后可见项在前，其余已保存项保留在后', () => {
    expect(reorderSessionIds(['x', 'a', 'b'], ['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b', 'x'])
  })

  it('本项目与全部的组内顺序一致：新建的在上，创建时间优先于编号', () => {
    const local = { id: 'p1', name: 'one', path: '/one', kind: 'local', host: '' }
    const sessions = [
      { id: 'old', number: 9, createdAt: 100, name: 'old', exit: null, project: local },
      { id: 'new', number: 2, createdAt: 300, name: 'new', exit: null, project: local },
      { id: 'pin', number: 1, createdAt: 50, name: 'pin', exit: null, project: local },
      { id: 'mid', number: 5, createdAt: 200, name: 'mid', exit: null, project: local },
    ]
    for (const options of [{}, { pins: ['pin'] }, { order: ['mid', 'old'] }, { pins: ['pin'], order: ['old', 'new'] }]) {
      const { pins = [], order = [] } = options as { pins?: string[]; order?: string[] }
      const scoped = orderSessions(sessions, pins, { order }).map((item: { session: { id: string } }) => item.session.id)
      const grouped = groupSessionOverview(sessions, { projects: [local], pins: () => pins, sessionOrder: () => order })[0].sessions.map((item: { id: string }) => item.id)
      expect(scoped).toEqual(grouped)
    }
    expect(orderSessions(sessions).map((item: { session: { id: string } }) => item.session.id)).toEqual(['new', 'mid', 'old', 'pin'])
    // 编号回退：没有创建时间时大的在上。
    expect(orderSessions([{ id: 'a', number: 1 }, { id: 'b', number: 2 }]).map((item: { session: { id: string } }) => item.session.id)).toEqual(['b', 'a'])
  })

  it('本项目列表：置顶最前，其后按手动顺序，运行中优先时忽略手动顺序', () => {
    const sessions = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, exit: null, programBusy: id === 'd' }))
    const ids = (options: object, pins: string[] = []) => orderSessions(sessions, pins, options).map((item: { session: { id: string } }) => item.session.id)
    // 不在手动顺序里的排在前面，刚新建的终端不会沉到底部。
    expect(ids({ order: ['c', 'a'] })).toEqual(['b', 'd', 'c', 'a'])
    expect(ids({ order: ['c', 'a'] }, ['b'])).toEqual(['b', 'd', 'c', 'a'])
    expect(ids({ order: ['c', 'a'], runningFirst: true })).toEqual(['d', 'a', 'b', 'c'])
  })

  it('只有手机会话的项目自动加入侧栏，电脑终端不算', () => {
    expect(phoneSessionProjectIds([
      { id: '1', project: { id: 'p1' } },
      { id: '2', project: { id: 'p1' } },
      { id: '3', origin: 'desktop', project: { id: 'p2' } },
      { id: '4' },
    ])).toEqual(['p1'])
  })

  it('有新结果：看不到的会话停下时标记，看过或重新工作时清除', () => {
    const tracker = { busy: new Set<string>(), attention: new Set<string>() }
    const session = (id: string, programBusy: boolean, exit: object | null = null) => ({ id, programBusy, exit })
    updateSessionAttention(tracker, [session('a', true), session('b', true), session('c', false)], 'b')
    expect([...tracker.attention]).toEqual([])
    updateSessionAttention(tracker, [session('a', false), session('b', false), session('c', false)], 'b')
    // 当前会话 b 停下不标记；c 一直没工作也不标记。
    expect([...tracker.attention]).toEqual(['a'])
    updateSessionAttention(tracker, [session('a', true)], 'b')
    expect([...tracker.attention]).toEqual([])
    updateSessionAttention(tracker, [session('a', false, { code: 0 })], 'b')
    expect([...tracker.attention]).toEqual(['a'])
    updateSessionAttention(tracker, [], 'a')
    expect([...tracker.attention]).toEqual([])
  })
})

describe('Android 会话纵览', () => {
  const local = { id: 'p1', name: 'Alpha', kind: 'local', path: 'D:/a', host: '' }
  const remote = { id: 'p2', name: 'Beta', kind: 'ssh', path: '/srv/b', host: '10.0.0.2' }
  const gone = { id: 'p3', name: 'Gamma', kind: 'wsl', path: '/g', host: '' }
  const list = [
    { id: 'm3', number: 3, name: 'Claude Code', exit: null, project: remote, deviceName: 'Pixel', ownDevice: true },
    { id: 'm1', number: 1, name: '终端 1', exit: null, project: local, deviceName: 'Pixel', ownDevice: true },
    { id: 'm2', number: 2, name: 'vim', exit: { code: 0 }, project: local, deviceName: 'Tablet', ownDevice: false },
    { id: 'm4', number: 4, name: 'build', exit: null, project: gone, deviceName: 'Tablet', ownDevice: false },
  ]
  const projects = [local, { ...remote, connectionName: 'prod' }]

  it('组内置顶的最靠前，优先于运行中优先和手动顺序', () => {
    const at = (id: string, createdAt: number, programBusy = false) =>
      ({ id, number: 1, createdAt, programBusy, name: id, exit: null, project: local })
    const sessions = [at('a', 300), at('b', 200, true), at('c', 100)]
    const ids = (options: object) => groupSessionOverview(sessions, { projects, pins: () => ['c'], ...options })[0].sessions.map((item: { id: string }) => item.id)
    expect(ids({})).toEqual(['c', 'a', 'b'])
    expect(ids({ runningFirst: true })).toEqual(['c', 'b', 'a'])
    expect(ids({ sessionOrder: () => ['b', 'a'] })).toEqual(['c', 'b', 'a'])
  })

  it('本项目与全部的信息行字段和顺序一致', () => {
    const base = { id: 'm1', number: 3, name: 'Claude', exit: null }
    expect(sessionStatusLine(base, { running: true, active: true })).toBe('终端 3 · 运行中 · 当前会话')
    expect(sessionStatusLine(base, { pinned: true, fresh: true, last: true })).toBe('已置顶 · 终端 3 · 有新结果 · 上次使用')
    // 名称已是「终端 N」时不重复编号，当前会话优先于上次使用。
    expect(sessionStatusLine({ ...base, name: '终端 3' }, { active: true, last: true })).toBe('当前会话')
    expect(sessionStatusLine({ ...base, exit: { code: 0 } }, { running: true, active: true })).toBe('终端 3 · 已结束')
    expect(sessionStatusLine({ ...base, inUseHere: false, controllerName: 'Pixel', ownDevice: false, deviceName: 'Tablet' }))
      .toBe('终端 3 · 在 Pixel 上使用中 · 来自 Tablet')
    // 已结束的会话没有使用方；电脑终端不显示编号。
    expect(sessionStatusLine({ ...base, exit: { code: 0 }, inUseHere: false, controllerName: 'Pixel' })).toBe('终端 3 · 已结束')
    expect(sessionStatusLine({ ...base, origin: 'desktop' })).toBe('电脑终端')
    // 没有编号时用调用方给的序号。
    expect(sessionStatusLine({ id: 'm2', name: 'vim', exit: null }, { fallback: 2 })).toBe('终端 2')
  })

  it('组内新创建的在上，运行中优先时仍先排运行中', () => {
    const at = (id: string, number: number, createdAt?: number, programBusy = false) =>
      ({ id, number, createdAt, programBusy, name: id, exit: null, project: local })
    const ids = (sessions: unknown[], runningFirst = false) =>
      groupSessionOverview(sessions, { projects, runningFirst })[0].sessions.map((item: { id: string }) => item.id)
    // 编号会被复用，创建时间优先于编号。
    expect(ids([at('old', 9, 100), at('new', 2, 300), at('mid', 5, 200)])).toEqual(['new', 'mid', 'old'])
    // 没有创建时间的排在后面，彼此按编号倒序。
    expect(ids([at('a', 1), at('b', 2), at('c', 3, 100)])).toEqual(['c', 'b', 'a'])
    expect(ids([at('new', 2, 300), at('busy', 1, 100, true)], true)).toEqual(['busy', 'new'])
  })

  it('按项目分组，当前项目在前，其余按最近打开，组内编号倒序；电脑端已移除的项目标记 missing', () => {
    const groups = groupSessionOverview(list, { projects, current: 'p2', history: [{ id: 'p3', openedAt: 5 }, { id: 'p1', openedAt: 2 }] })
    expect(groups.map(group => group.project.id)).toEqual(['p2', 'p3', 'p1'])
    expect(groups[0].project.connectionName).toBe('prod')
    expect(groups[1].missing).toBe(true)
    expect(groups[2].sessions.map(session => session.id)).toEqual(['m2', 'm1'])
    expect(groupSessionOverview(list, { projects }).map(group => group.project.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('侧栏固定顺序：切换当前项目和最近打开时间都不改变分组位置', () => {
    const ids = (current: string, openedAt: number) => groupSessionOverview(list, {
      projects, current, history: [{ id: 'p1', openedAt }], order: ['p2', 'p1'],
    }).map(group => group.project.id)
    expect(ids('p1', 5)).toEqual(['p2', 'p1', 'p3'])
    expect(ids('p2', 9)).toEqual(['p2', 'p1', 'p3'])
  })

  it('常驻项目没有会话时显示空分组，筛选、搜索和电脑端已移除时不显示', () => {
    const groups = groupSessionOverview([], { projects, order: ['p2', 'p9'] })
    expect(groups.map(group => [group.project.id, group.sessions.length, group.member])).toEqual([['p2', 0, true]])
    expect(groupSessionOverview([], { projects, order: ['p2'], filter: 'live' })).toEqual([])
    expect(groupSessionOverview([], { projects, order: ['p2'], query: 'beta' })).toEqual([])
    expect(groupSessionOverview(list, { projects, order: ['p2'] }).at(-1)?.member).toBe(false)
  })

  it('组内手动顺序优先，新会话在已排序会话之前，运行中优先时不生效', () => {
    const at = (id: string, createdAt: number, programBusy = false) =>
      ({ id, createdAt, programBusy, name: id, exit: null, project: local })
    const sessions = [at('a', 100), at('b', 200, true), at('c', 300), at('new', 400)]
    const ids = (runningFirst = false) => groupSessionOverview(sessions, {
      projects, runningFirst, order: ['p1'], sessionOrder: () => ['a', 'c', 'b'],
    })[0].sessions.map((item: { id: string }) => item.id)
    expect(ids()).toEqual(['new', 'a', 'c', 'b'])
    expect(ids(true)).toEqual(['b', 'new', 'c', 'a'])
  })

  it('筛选未结束/已结束，计数与搜索多个关键词', () => {
    expect(countSessionOverview(list)).toEqual({ all: 4, live: 3, exited: 1 })
    expect(groupSessionOverview(list, { projects, filter: 'exited' }).flatMap(group => group.sessions.map(item => item.id))).toEqual(['m2'])
    expect(groupSessionOverview(list, { projects, filter: 'live' }).flatMap(group => group.sessions.map(item => item.id))).toEqual(['m1', 'm3', 'm4'])
    expect(groupSessionOverview(list, { projects, query: 'alpha VIM' }).flatMap(group => group.sessions.map(item => item.id))).toEqual(['m2'])
    expect(groupSessionOverview(list, { projects, query: 'tablet' }).flatMap(group => group.sessions.map(item => item.id))).toEqual(['m2', 'm4'])
    expect(groupSessionOverview(list, { projects, query: 'prod' }).flatMap(group => group.sessions.map(item => item.id))).toEqual(['m3'])
    expect(groupSessionOverview(list, { projects, query: 'nothing' })).toEqual([])
  })

  it('首页按分组顺序只先显示前若干个会话，并给出未显示数量', () => {
    const groups = groupSessionOverview(list, { projects })
    const limited = limitSessionGroups(groups, 3)
    expect(limited.hidden).toBe(1)
    expect(limited.groups.map(group => [group.project.id, group.sessions.map(item => item.id), group.total])).toEqual([['p1', ['m2', 'm1'], 2], ['p2', ['m3'], 1]])
    expect(limitSessionGroups(groups, 8)).toEqual({ groups, hidden: 0 })
    expect(limitSessionGroups(groups, Infinity).hidden).toBe(0)
  })

  it('批量关闭统计运行中、已结束、其他设备与项目数；多选随列表刷新去掉已不存在的会话', () => {
    expect(summarizeSessionBatch(list)).toEqual({ total: 4, running: 3, ended: 1, others: 1, projects: 3 })
    expect(summarizeSessionBatch([])).toEqual({ total: 0, running: 0, ended: 0, others: 0, projects: 0 })
    expect([...prunedSelection(new Set(['m4', 'gone', 'm1']), list)]).toEqual(['m4', 'm1'])
  })

  it('从全部会话中取出当前项目的会话，去掉纵览附带字段', () => {
    expect(projectSessionsFromOverview(list, 'p1')).toEqual([
      { id: 'm1', number: 1, name: '终端 1', exit: null },
      { id: 'm2', number: 2, name: 'vim', exit: { code: 0 } },
    ])
    expect(list[1].project).toBe(local)
  })
})

describe('session created time and running order', () => {
  it('labels the creation time and skips sessions from older desktops', () => {
    const now = new Date(2026, 10, 7, 23, 40).getTime()
    expect(createdLabel({ createdAt: new Date(2026, 10, 7, 9, 5).getTime() }, now)).toBe('创建于 09:05')
    expect(createdLabel({ createdAt: new Date(2026, 0, 3, 18, 30).getTime() }, now)).toBe('创建于 01-03 18:30')
    expect(createdLabel({ createdAt: new Date(2025, 11, 31, 8, 0).getTime() }, now)).toBe('创建于 2025-12-31 08:00')
    expect(createdLabel({}, now)).toBe('')
  })

  it('puts running sessions first after pins only when the running-first option is on', () => {
    const list = [
      { id: 'a', number: 1, programBusy: false, project: { id: 'p', name: 'P' } },
      { id: 'b', number: 2, programBusy: true, project: { id: 'p', name: 'P' } },
      { id: 'c', number: 3, programBusy: false, project: { id: 'p', name: 'P' } },
      { id: 'd', number: 4, programBusy: true, exit: { exitCode: 0 }, project: { id: 'p', name: 'P' } },
    ]
    expect(orderSessions(list, ['c']).map(item => item.session.id)).toEqual(['c', 'd', 'b', 'a'])
    expect(orderSessions(list, ['c'], { runningFirst: true }).map(item => item.session.id)).toEqual(['c', 'b', 'd', 'a'])
    expect(groupSessionOverview(list)[0].sessions.map(session => session.id)).toEqual(['d', 'c', 'b', 'a'])
    expect(groupSessionOverview(list, { runningFirst: true })[0].sessions.map(session => session.id)).toEqual(['b', 'd', 'c', 'a'])
  })
})
