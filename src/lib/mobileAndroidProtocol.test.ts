import { describe, expect, it } from 'vitest'
import { buildPairingLink, formatFingerprint } from './mobilePairing'
// Android WebView 资产与桌面共用同一套配对链接格式。
import {
  formatDuration,
  idleLabel,
  MODIFIER_LOCK_WINDOW,
  PULL_MAX,
  PULL_THRESHOLD,
  applyModifiers,
  avatarFor,
  consumeModifier,
  keySequence,
  matchesProject,
  nextModifierState,
  orderSessions,
  outputBatches,
  outputChunk,
  parsePairingLink,
  parseSessionPins,
  prunedSessionPins,
  SESSION_PIN_LIMIT,
  projectSourceLabel,
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
    expect(sessionName({ name: '✳ Claude Code' })).toBe('✳ Claude Code')
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
})
